-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.65 — delete confirmed matter-named entries from the Precedent Library
--
-- DESTRUCTIVE. Run only after reviewing review_precedent_library.sql output.
--
-- Paste the confirmed precedent_id values into the list below. Nothing is
-- deleted by name or by pattern: only the ids you put there, so a precedent
-- that merely resembles a matter name cannot be caught by accident.
--
-- precedent_chunks is deleted explicitly rather than relying on a cascade —
-- the foreign key's ON DELETE behaviour is not recorded anywhere in this
-- repository, and an orphaned chunk table would still feed the drafting
-- prompt.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The ids to delete — replace these with the confirmed ones ────────────
CREATE TEMP TABLE to_delete (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO to_delete (id) VALUES
  ('00000000-0000-0000-0000-000000000000')   -- replace
-- ,('00000000-0000-0000-0000-000000000000')
;

-- ── 2. Show exactly what is about to go, one last time ──────────────────────
SELECT p.id, p.name,
       (SELECT count(*) FROM precedent_chunks c WHERE c.precedent_doc_id = p.id) AS chunks_to_delete
  FROM precedent_docs p JOIN to_delete d ON d.id = p.id;

-- ── 3. Safety check — every id must exist, or something is wrong ────────────
DO $$
DECLARE wanted int; found int;
BEGIN
  SELECT count(*) INTO wanted FROM to_delete;
  SELECT count(*) INTO found  FROM precedent_docs p JOIN to_delete d ON d.id = p.id;
  IF wanted <> found THEN
    RAISE EXCEPTION 'Refusing to delete: % ids listed but % found in precedent_docs', wanted, found;
  END IF;
END $$;

-- ── 4. Delete the chunks, then the rows ─────────────────────────────────────
DELETE FROM precedent_chunks
 WHERE precedent_doc_id IN (SELECT id FROM to_delete);

DELETE FROM precedent_docs
 WHERE id IN (SELECT id FROM to_delete);

-- Check the counts above, then COMMIT. ROLLBACK undoes the whole thing.
COMMIT;
