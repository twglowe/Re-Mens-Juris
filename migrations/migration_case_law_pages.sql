-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.64 — page numbers on case law chunks, for pinpoint citation
-- Run in Supabase SQL Editor as a single block. Safe to run more than once.
--
-- A citation without a pinpoint is half a citation. This records, for each
-- stored chunk, the page it came from — the judgment's OWN internal page
-- number where the extractor could read one, falling back to the page's
-- position in the file. In a bundle those differ: judgment 2 may begin on
-- the file's page 40 and its own page 1, and it is the latter a court wants.
--
-- The app degrades gracefully if this has not been run: chunks are stored
-- without a page, and the draft prompt simply carries no [p.N] markers.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. The column ───────────────────────────────────────────────────────────
ALTER TABLE case_law_chunks ADD COLUMN IF NOT EXISTS page_number integer;

-- ── 2. Teach the ranked search to return it ─────────────────────────────────
-- The return type gains a column, and Postgres will not change a function's
-- return type in place, so the old one is dropped first. Dropping and
-- recreating in one block is atomic; no window where the function is missing.
DROP FUNCTION IF EXISTS case_law_search(uuid, text, uuid[], integer);

CREATE FUNCTION case_law_search(
  p_user_id uuid,
  p_query   text,
  p_doc_ids uuid[] DEFAULT NULL,
  p_limit   integer DEFAULT 80
)
RETURNS TABLE (
  case_law_id uuid,
  chunk_index integer,
  page_number integer,
  content     text,
  rank        real
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.case_law_id,
         c.chunk_index,
         c.page_number,
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

GRANT EXECUTE ON FUNCTION case_law_search(uuid, text, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION case_law_search(uuid, text, uuid[], integer) TO authenticated;

-- ── 3. Verification (run separately) ────────────────────────────────────────
-- SELECT count(*) FILTER (WHERE page_number IS NOT NULL) AS with_page,
--        count(*) AS total FROM case_law_chunks;
