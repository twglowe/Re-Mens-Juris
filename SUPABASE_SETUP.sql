-- Run this in Supabase SQL Editor (Database → SQL Editor → New Query)
-- Mens Juris v1 — Full schema with user auth and matter sharing

-- Matters table (with owner)
CREATE TABLE IF NOT EXISTS matters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'Bermuda',
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Matter shares table
CREATE TABLE IF NOT EXISTS matter_shares (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(matter_id, user_id)
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'Other',
  char_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks table (indexed text passages)
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

-- Full text search index
CREATE INDEX IF NOT EXISTS chunks_content_fts ON chunks USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS chunks_matter_id_idx ON chunks(matter_id);
CREATE INDEX IF NOT EXISTS documents_matter_id_idx ON documents(matter_id);
CREATE INDEX IF NOT EXISTS matters_owner_id_idx ON matters(owner_id);
CREATE INDEX IF NOT EXISTS matter_shares_user_id_idx ON matter_shares(user_id);

-- Row Level Security
ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

-- Policies (server uses service key so bypasses RLS, but good practice)
CREATE POLICY "Service role full access" ON matters FOR ALL USING (true);
CREATE POLICY "Service role full access" ON matter_shares FOR ALL USING (true);
CREATE POLICY "Service role full access" ON documents FOR ALL USING (true);
CREATE POLICY "Service role full access" ON chunks FOR ALL USING (true);
