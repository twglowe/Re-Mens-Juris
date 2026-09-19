-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ Document Sift, Push 1 — the tables the sift writes its judgements into
-- See docs/SPEC_Document_Sift.md. Run in Supabase SQL Editor as a single block.
-- Safe to run more than once.
--
-- The Sift reads several thousand PDFs off a USB without uploading or storing
-- them. What it keeps is only the judgement: metadata, scores, verdicts and a
-- short note per document. That is what lives here. No document text from the
-- production is stored by these tables at any point.
--
-- Nothing existing reads any of this. Two new tables, two nullable columns on
-- `documents`, and no change to any current query — so running this changes
-- the behaviour of exactly nothing until Push 2 arrives.
--
-- Ownership is `owner_id`, following `drafts`, which is the closest precedent:
-- a matter-scoped table carrying both `matter_id` and `owner_id`. The
-- denormalised owner lets a handler check ownership in one query rather than
-- joining through `matters` every time. Note `documents` and `chunks` do NOT
-- work this way — they carry no ownership column and are scoped through
-- `matter_id` alone.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. sift_frames — the condensed brief, built once per matter ─────────────
-- The frame is read by the model once per document, so it is deliberately
-- compact (target under 8,000 tokens) and lives in the system prompt under the
-- cache_control breakpoint. One row per build: a chronology updated after a
-- first sift produces a new version rather than overwriting the old, so a
-- verdict can always be traced to the frame it was judged against.
CREATE TABLE IF NOT EXISTS sift_frames (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id   uuid        NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  owner_id    uuid        NOT NULL,
  brief       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rules       text        DEFAULT '',
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (matter_id, version)
);

CREATE INDEX IF NOT EXISTS sift_frames_matter_idx
  ON sift_frames (matter_id, version DESC);


-- ── 2. sift_documents — one row per file in the production ──────────────────
-- Enums are `text` with a CHECK rather than a Postgres enum type. Adding a
-- value to a CHECK is a one-line ALTER; adding one to an enum type is not, and
-- these vocabularies (novelty, issue_effect, bundle_ref_source) are the most
-- likely things in the whole design to gain a case once real files arrive.
--
-- A CHECK passes on NULL, so every one of these stays optional until the tier
-- that fills it has run. A row exists from the moment the folder is listed,
-- long before it has been scored.
CREATE TABLE IF NOT EXISTS sift_documents (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id   uuid        NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  frame_id    uuid        REFERENCES sift_frames(id) ON DELETE SET NULL,
  owner_id    uuid        NOT NULL,
  created_at  timestamptz DEFAULT now(),

  -- The file, as found on disk. sha256 is of the file bytes, so an identical
  -- copy sitting elsewhere in the production is recognised before it is read.
  relative_path text      NOT NULL,
  sha256        text      NOT NULL,

  -- Tier 1 and Tier 2 results.
  doc_type        text      DEFAULT '',
  doc_date        date,
  parties         text[]    DEFAULT '{}',
  relevance       integer   CHECK (relevance BETWEEN 0 AND 100),
  novelty         text      CHECK (novelty IN ('covered', 'adds_detail',
                                               'new_event', 'uncertain',
                                               'not_relevant')),
  chronology_refs text[]    DEFAULT '{}',
  issue_refs      integer[] DEFAULT '{}',
  note            text      DEFAULT '',
  confidence      text      CHECK (confidence IN ('high', 'medium', 'low')),
  tier            integer   CHECK (tier IN (1, 2)),

  -- Duplicates and email threads, both settled in the browser before any model
  -- call. Only a representative is scored, so the model reads each piece of
  -- content once and the index shows one row per thing.
  duplicate_of      uuid    REFERENCES sift_documents(id) ON DELETE SET NULL,
  similarity        real,
  thread_id         text,
  thread_position   integer,
  superseded_by     uuid    REFERENCES sift_documents(id) ON DELETE SET NULL,
  is_representative boolean DEFAULT true,
  message_count     integer,

  -- Review mode. `decision` is null until the document is decided on; a
  -- discarded document keeps its row so it can be reinstated, and is never
  -- deleted. `manual_verdict` records a novelty the user overrode, which feeds
  -- the frame's Rules on the next sift.
  issue_effect    text        CHECK (issue_effect IN ('adds', 'changes', 'neutral')),
  decision        text        CHECK (decision IN ('keep', 'discard', 'defer')),
  decided_at      timestamptz,
  chronology_line text,
  manual_verdict  text        CHECK (manual_verdict IN ('covered', 'adds_detail',
                                                        'new_event', 'uncertain',
                                                        'not_relevant')),

  -- Accept: the single gate between the sift and the ordinary tools, and the
  -- only point at which storage cost is incurred.
  uploaded_document_id uuid        REFERENCES documents(id) ON DELETE SET NULL,
  accepted_at          timestamptz,
  accept_batch_id      uuid,

  -- Trial bundle references. `matched_document_id` is a document the matter
  -- ALREADY holds, which this file turned out to be a copy of — the reference
  -- is written onto that existing row and this file is never uploaded. Quite
  -- distinct from `uploaded_document_id`, which is a document Accept created.
  bundle_ref        text,
  bundle_ref_source text    CHECK (bundle_ref_source IN ('index', 'filename',
                                                         'page_stamp', 'manual')),
  matched_document_id uuid  REFERENCES documents(id) ON DELETE SET NULL,
  match_strength    text    CHECK (match_strength IN ('strong', 'weak')),
  match_confirmed   boolean DEFAULT false,

  -- The same file cannot be sifted twice into one matter. This is also what
  -- makes a re-run cheap: a second pass skips anything already verdicted.
  UNIQUE (matter_id, sha256)
);

-- The index is sorted by novelty then relevance and filtered constantly, and a
-- production is several thousand rows, so these are worth having from the off.
CREATE INDEX IF NOT EXISTS sift_documents_matter_idx
  ON sift_documents (matter_id);
CREATE INDEX IF NOT EXISTS sift_documents_novelty_idx
  ON sift_documents (matter_id, novelty, relevance DESC);
CREATE INDEX IF NOT EXISTS sift_documents_frame_idx
  ON sift_documents (frame_id);
CREATE INDEX IF NOT EXISTS sift_documents_thread_idx
  ON sift_documents (matter_id, thread_id);
CREATE INDEX IF NOT EXISTS sift_documents_decision_idx
  ON sift_documents (matter_id, decision);


-- ── 3. Trial bundle references on the matter's own documents ────────────────
-- Many sifted files are already in the matter; what the production adds is the
-- bundle reference. Both columns are nullable and nothing reads them yet, so
-- adding them is inert. Push 10 reads `bundle_ref` behind a feature flag and
-- tolerates its absence, the way `case_law_chunks.page_number` is handled.
--
-- Where a re-paginated bundle gives a document a new reference, the old one
-- moves to `bundle_ref_prior` rather than being lost, so citations made under
-- the previous pagination can still be traced.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS bundle_ref       text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS bundle_ref_prior text;


-- ── 4. RLS and grants ───────────────────────────────────────────────────────
-- This follows the pattern every other table in the app uses (see
-- SUPABASE_SETUP.sql): RLS on, with a permissive policy, because the app
-- reaches Supabase with the service-role key, which bypasses RLS entirely.
-- The real permission check is done in the handler, as CLAUDE.md records.
--
-- Being plain about it: this policy is not what keeps one user's sift out of
-- another's. `api/sift-*` checking owner-or-sharer on every call is. A policy
-- restricted to auth.uid() would be stricter, but it would also be the only
-- table in ELJ behaving that way, and any path using the anon key would break
-- against it. Consistency is worth more here than a control the service key
-- steps over anyway.
ALTER TABLE sift_frames    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sift_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON sift_frames;
DROP POLICY IF EXISTS "Service role full access" ON sift_documents;

CREATE POLICY "Service role full access" ON sift_frames    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON sift_documents FOR ALL USING (true);

GRANT ALL ON sift_frames    TO anon, authenticated, service_role;
GRANT ALL ON sift_documents TO anon, authenticated, service_role;


-- ── 5. Verification (run separately) ────────────────────────────────────────
-- Expect 2 rows: sift_documents, sift_frames.
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public' AND table_name LIKE 'sift%'
--  ORDER BY table_name;
--
-- Expect 2 rows: bundle_ref, bundle_ref_prior.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'documents' AND column_name LIKE 'bundle_ref%'
--  ORDER BY column_name;
--
-- Expect 0 rows. Existing tools are untouched by this migration, so anything
-- appearing here means something has gone wrong.
-- SELECT count(*) FROM sift_documents;
