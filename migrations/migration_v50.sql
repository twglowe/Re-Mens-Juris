-- ═══════════════════════════════════════════════════════════════════════════════
-- ELJ v5.0 — Document categorisation (folders) migration
-- Run in Supabase SQL Editor as a single block.
--
-- Adds:
--   • folders                  — per-matter container, many-to-one with matters
--   • document_folders         — many-to-many join, one document in 0..N folders
--   • user_folder_defaults     — per-user growing list of folder name suggestions
--   • documents.description    — editable per-document description
--
-- Does NOT modify documents.name, chunks, matters, or any existing column.
-- Existing documents have zero rows in document_folders, which the UI treats as
-- "Uncategorised". No backfill required.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. folders ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id   uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, name)
);

CREATE INDEX IF NOT EXISTS folders_matter_id_idx ON folders(matter_id);

-- ── 2. document_folders (join) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_folders (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id   uuid NOT NULL REFERENCES folders(id)   ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, folder_id)
);

CREATE INDEX IF NOT EXISTS document_folders_folder_id_idx ON document_folders(folder_id);
CREATE INDEX IF NOT EXISTS document_folders_document_id_idx ON document_folders(document_id);

-- ── 3. user_folder_defaults ─────────────────────────────────────────────────
-- Per-user growing list of folder name suggestions. Upserted whenever the
-- user creates a folder in any matter. Renames do not touch this table.
CREATE TABLE IF NOT EXISTS user_folder_defaults (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

-- ── 4. documents.description ────────────────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- ── 5. Seed user_folder_defaults for the existing user ─────────────────────
-- Gives the suggestion list a starter set the first time you open the
-- "+ new folder" picker, before you have created any folders organically.
-- Safe to run multiple times — ON CONFLICT DO NOTHING.
DO $$
DECLARE
  uid uuid;
  starter_folders text[] := ARRAY[
    'Pleadings',
    'Affidavits',
    'Discovery',
    'Applications',
    'Hearing Bundles',
    'Correspondence',
    'Exhibits',
    'Witness Statements',
    'Expert Reports',
    'Orders and Judgments'
  ];
  fname text;
BEGIN
  FOR uid IN SELECT id FROM auth.users LOOP
    FOREACH fname IN ARRAY starter_folders LOOP
      INSERT INTO user_folder_defaults (user_id, name)
      VALUES (uid, fname)
      ON CONFLICT (user_id, name) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- ── 6. Verification queries (run separately, single line each) ──────────────
-- SELECT count(*) FROM folders;
-- SELECT count(*) FROM document_folders;
-- SELECT count(*) FROM user_folder_defaults;
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='documents' AND column_name='description';
