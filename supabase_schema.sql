-- Supabase Schema for Visibility Docs AI

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'starter',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  organization_id UUID REFERENCES organizations(id),
  role TEXT DEFAULT 'viewer',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  document_type TEXT,
  status TEXT DEFAULT 'uploaded',
  original_file_url TEXT,
  file_hash TEXT,
  page_count INTEGER,
  file_size BIGINT,
  language TEXT,
  raw_text TEXT,
  error_message TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_documents_org_id ON documents(organization_id);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_type ON documents(document_type);

-- Document Pages
CREATE TABLE document_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_url TEXT,
  thumbnail_url TEXT,
  raw_text TEXT,
  ocr_confidence NUMERIC,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pages_doc_id ON document_pages(document_id);

-- Document Chunks (for RAG)
CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_id UUID,
  chunk_type TEXT DEFAULT 'paragraph',
  heading TEXT,
  content TEXT NOT NULL,
  bbox JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chunks_doc_id ON document_chunks(document_id);
CREATE INDEX idx_chunks_org_id ON document_chunks(organization_id);

-- Document Embeddings (for vector search)
CREATE TABLE document_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES document_chunks(id) ON DELETE CASCADE,
  embedding VECTOR(384),
  model_name TEXT DEFAULT 'all-MiniLM-L6-v2',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_embeddings_doc_id ON document_embeddings(document_id);
CREATE INDEX idx_embeddings_org_id ON document_embeddings(organization_id);

-- Document Extractions
CREATE TABLE document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_type TEXT NOT NULL,
  extracted_data JSONB NOT NULL,
  confidence NUMERIC DEFAULT 0,
  reviewed BOOLEAN DEFAULT false,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Processing Jobs
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Agent Tool Gateway audit trail (plan Step 4: tamper-proof tool invocation log)
CREATE TABLE IF NOT EXISTS agent_tool_audit (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT,
  user_id TEXT,
  risk_tier TEXT NOT NULL DEFAULT 'read',
  decision TEXT NOT NULL DEFAULT 'allow',
  input_payload TEXT,
  result_status TEXT NOT NULL DEFAULT 'started',
  result_summary TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_org ON agent_tool_audit(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_tool ON agent_tool_audit(tool_name);

-- Append-only: the audit trail must never be amended or pruned by an
-- application bug or a tampered client. The trigger blocks UPDATE/DELETE even
-- for the service-role key (triggers fire regardless of RLS bypass); to
-- legitimately clean the table, drop the trigger first, then re-create it.
CREATE OR REPLACE FUNCTION block_agent_tool_audit_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'agent_tool_audit is append-only; UPDATE/DELETE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_agent_tool_audit_mutation ON agent_tool_audit;
CREATE TRIGGER trg_block_agent_tool_audit_mutation
    BEFORE UPDATE OR DELETE ON agent_tool_audit
    FOR EACH ROW EXECUTE FUNCTION block_agent_tool_audit_mutation();

-- Hide the audit trail from anon/authenticated roles (the app talks to
-- Supabase with a service-role key, which bypasses RLS, so reads/writes still
-- work); only the backend can see or append rows.
ALTER TABLE agent_tool_audit ENABLE ROW LEVEL SECURITY;

-- Vector search function
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(384),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_org_id TEXT DEFAULT NULL
)
RETURNS TABLE(
  id UUID,
  document_id UUID,
  organization_id UUID,
  content TEXT,
  similarity FLOAT,
  metadata JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.organization_id,
    dc.content,
    1 - (de.embedding <=> query_embedding) AS similarity,
    dc.metadata
  FROM document_embeddings de
  JOIN document_chunks dc ON dc.id = de.chunk_id
  WHERE (filter_org_id IS NULL OR dc.organization_id = filter_org_id::UUID)
    AND (1 - (de.embedding <=> query_embedding)) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- Enable Row Level Security
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies (users can only access their org's data)
CREATE POLICY org_isolation ON documents
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

CREATE POLICY org_isolation_chunks ON document_chunks
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

CREATE POLICY org_isolation_embeddings ON document_embeddings
  USING (organization_id = (SELECT organization_id FROM users WHERE id = auth.uid()));
