-- Mens Juris v2 — Run this in Supabase SQL Editor
-- Safe to run multiple times (uses IF NOT EXISTS throughout)

-- Matters table
CREATE TABLE IF NOT EXISTS matters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'Bermuda',
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_count INTEGER DEFAULT 0,
  nature TEXT DEFAULT '',
  issues TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add context columns if upgrading from v1
ALTER TABLE matters ADD COLUMN IF NOT EXISTS nature TEXT DEFAULT '';
ALTER TABLE matters ADD COLUMN IF NOT EXISTS issues TEXT DEFAULT '';

-- Matter shares
CREATE TABLE IF NOT EXISTS matter_shares (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(matter_id, user_id)
);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'Other',
  char_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks
CREATE TABLE IF NOT EXISTS chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'Other',
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation history
CREATE TABLE IF NOT EXISTS conversation_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  tool_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS chunks_content_fts ON chunks USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS chunks_matter_id_idx ON chunks(matter_id);
CREATE INDEX IF NOT EXISTS documents_matter_id_idx ON documents(matter_id);
CREATE INDEX IF NOT EXISTS matters_owner_id_idx ON matters(owner_id);
CREATE INDEX IF NOT EXISTS matter_shares_user_id_idx ON matter_shares(user_id);
CREATE INDEX IF NOT EXISTS history_matter_user_idx ON conversation_history(matter_id, user_id);

-- Row Level Security
ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies cleanly
DO $$ BEGIN
  DROP POLICY IF EXISTS "Service role full access" ON matters;
  DROP POLICY IF EXISTS "Service role full access" ON matter_shares;
  DROP POLICY IF EXISTS "Service role full access" ON documents;
  DROP POLICY IF EXISTS "Service role full access" ON chunks;
  DROP POLICY IF EXISTS "Service role full access" ON conversation_history;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "Service role full access" ON matters FOR ALL USING (true);
CREATE POLICY "Service role full access" ON matter_shares FOR ALL USING (true);
CREATE POLICY "Service role full access" ON documents FOR ALL USING (true);
CREATE POLICY "Service role full access" ON chunks FOR ALL USING (true);
CREATE POLICY "Service role full access" ON conversation_history FOR ALL USING (true);
