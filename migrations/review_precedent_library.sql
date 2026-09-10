-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.65 — review the Precedent Library for matter-named entries
--
-- READ ONLY. Nothing here deletes anything. Run each query on its own and
-- send the results back; the deletion script is a separate file and takes an
-- explicit list of ids.
--
-- Cause of the problem: public/js/library.js precUpFileChanged asked Claude
-- for "the case name (e.g. Smith v Jones) or the first party name" when the
-- precedent's name field was left empty, so the suggestion offered was the
-- matter's name and accepting it filed the precedent under it. Fixed in
-- v5.65; these queries find what landed before that.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Query A — precedent names matching one of your matters ──────────────────
-- Either name containing the other, case- and punctuation-insensitive. This
-- is the list to confirm.
SELECT p.id            AS precedent_id,
       p.name          AS precedent_name,
       m.name          AS matter_name,
       p.jurisdiction,
       p.created_at,
       (SELECT count(*) FROM precedent_chunks c WHERE c.precedent_doc_id = p.id) AS chunks
  FROM precedent_docs p
  JOIN matters m
    ON m.owner_id = p.user_id
   AND (
        lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g'))
          LIKE '%' || lower(regexp_replace(m.name, '[^a-zA-Z0-9]', '', 'g')) || '%'
     OR lower(regexp_replace(m.name, '[^a-zA-Z0-9]', '', 'g'))
          LIKE '%' || lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) || '%'
       )
 ORDER BY p.name;

-- ── Query B — precedents that read as case names, matched or not ────────────
-- Catches an authority whose matter has since been renamed or deleted:
-- "X v Y", "Re X", "In re X", "X Appeal".
SELECT p.id   AS precedent_id,
       p.name AS precedent_name,
       p.jurisdiction,
       p.created_at,
       (SELECT count(*) FROM precedent_chunks c WHERE c.precedent_doc_id = p.id) AS chunks
  FROM precedent_docs p
 WHERE p.name ~* '( v\.? )|(^re )|(^in re )|( appeal$)|( ltd\.? v)'
 ORDER BY p.name;

-- ── Query C — the whole library, for eyeballing ─────────────────────────────
-- Smallest and most reliable check when the library is short: read it.
SELECT p.id, p.name, ct.name AS case_type, dt.name AS doc_type,
       p.jurisdiction, p.created_at,
       (SELECT count(*) FROM precedent_chunks c WHERE c.precedent_doc_id = p.id) AS chunks
  FROM precedent_docs p
  LEFT JOIN case_types ct ON ct.id = p.case_type_id
  LEFT JOIN doc_types  dt ON dt.id = p.doc_type_id
 ORDER BY p.name;

-- ── Query D — the three named examples, however they are spelled ────────────
SELECT p.id, p.name, p.created_at,
       (SELECT count(*) FROM precedent_chunks c WHERE c.precedent_doc_id = p.id) AS chunks
  FROM precedent_docs p
 WHERE p.name ILIKE '%tianrui%'
    OR p.name ILIKE '%thalassa%'
    OR p.name ILIKE '%51 jobs%'
    OR p.name ILIKE '%51jobs%'
 ORDER BY p.name;
