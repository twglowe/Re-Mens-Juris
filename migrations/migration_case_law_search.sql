-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.59 — Push C: relevance search over the case law library
-- Run in Supabase SQL Editor as a single block. Safe to run more than once.
--
-- Adds:
--   • a GIN full-text index on case_law_chunks.content — the same shape as
--     the existing chunks_content_fts index on matter chunks
--   • case_law_search(...) — ranked search, returning the chunks that best
--     match a query, newest-ranked first, optionally confined to a set of
--     case_law_docs (subject / sub-tag mode)
--
-- The worker calls the function and falls back to an unranked PostgREST
-- text search if it is missing, so the draft still works before this runs —
-- it just picks matching chunks rather than the best-matching ones.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Full-text index ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS case_law_chunks_content_fts
  ON case_law_chunks USING gin(to_tsvector('english', content));

-- Supporting index for the per-document fetch the draft does for authorities
-- linked to a matter.
CREATE INDEX IF NOT EXISTS case_law_chunks_case_law_id_idx
  ON case_law_chunks(case_law_id, chunk_index);

CREATE INDEX IF NOT EXISTS case_law_docs_user_subject_idx
  ON case_law_docs(user_id, subject_id);

-- ── 2. Ranked search function ───────────────────────────────────────────────
-- p_doc_ids NULL  => search the whole library for that user (General mode)
-- p_doc_ids array => confine the search to those documents (By subject mode)
--
-- ts_rank_cd weights by term density and proximity, so a chunk that turns on
-- the issue repeatedly beats one that mentions a single word in passing.
CREATE OR REPLACE FUNCTION case_law_search(
  p_user_id uuid,
  p_query   text,
  p_doc_ids uuid[] DEFAULT NULL,
  p_limit   integer DEFAULT 80
)
RETURNS TABLE (
  case_law_id uuid,
  chunk_index integer,
  content     text,
  rank        real
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.case_law_id,
         c.chunk_index,
         c.content,
         ts_rank_cd(to_tsvector('english', c.content),
                    websearch_to_tsquery('english', p_query)) AS rank
    FROM case_law_chunks c
   WHERE c.user_id = p_user_id
     AND (p_doc_ids IS NULL OR c.case_law_id = ANY(p_doc_ids))
     AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', p_query)
   ORDER BY rank DESC, c.case_law_id, c.chunk_index
   LIMIT GREATEST(p_limit, 1);
$$;

-- The API connects with the service role, which bypasses RLS; granting to
-- authenticated as well costs nothing and keeps the function usable if the
-- app ever calls it with a user token.
GRANT EXECUTE ON FUNCTION case_law_search(uuid, text, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION case_law_search(uuid, text, uuid[], integer) TO authenticated;

-- ── 3. Verification (run separately) ────────────────────────────────────────
-- SELECT count(*) FROM case_law_chunks;
-- SELECT name, rank FROM case_law_search('<your-user-uuid>', 'breach of trust') s
--   JOIN case_law_docs d ON d.id = s.case_law_id LIMIT 10;
