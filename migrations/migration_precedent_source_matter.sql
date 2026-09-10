-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.65 — record which matter a precedent came from
-- Run in Supabase SQL Editor as a single block. Safe to run more than once.
--
-- A precedent is a reusable template, but knowing the matter it came from is
-- what lets the AI judge its context: what the dispute was, what the issues
-- were, and so how far that situation matches the one now being drafted.
--
-- Until now that was carried in the precedent's NAME — which is why entries
-- like "Tianrui" and "Thalassa" appear in the library. The name is the wrong
-- place: it makes a template findable only by someone who remembers that
-- matter. This gives the link a column of its own, so names can describe the
-- document while the association survives.
--
-- Mirrors case_law_docs.source_matter_id from Push B, including ON DELETE
-- SET NULL: deleting a matter must not take its precedents with it.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE precedent_docs
  ADD COLUMN IF NOT EXISTS source_matter_id uuid REFERENCES matters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS precedent_docs_source_matter_idx
  ON precedent_docs(user_id, source_matter_id);

-- ── Backfill helper (READ ONLY — review before acting) ──────────────────────
-- Pairs each precedent whose name still carries a matter name with that
-- matter. Read the output, then set the links you agree with. Nothing here
-- changes a row.
--
-- SELECT p.id AS precedent_id, p.name AS precedent_name,
--        m.id AS matter_id,   m.name AS matter_name
--   FROM precedent_docs p
--   JOIN matters m
--     ON m.owner_id = p.user_id
--    AND (lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g'))
--           LIKE '%' || lower(regexp_replace(m.name, '[^a-zA-Z0-9]', '', 'g')) || '%'
--      OR lower(regexp_replace(m.name, '[^a-zA-Z0-9]', '', 'g'))
--           LIKE '%' || lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) || '%')
--  WHERE p.source_matter_id IS NULL
--  ORDER BY p.name;
--
-- Then, per row you accept:
-- UPDATE precedent_docs SET source_matter_id = '<matter_id>' WHERE id = '<precedent_id>';
--
-- The precedent can be renamed from the Library panel afterwards, or here:
-- UPDATE precedent_docs SET name = 'Skeleton Argument — unfair prejudice' WHERE id = '<precedent_id>';
