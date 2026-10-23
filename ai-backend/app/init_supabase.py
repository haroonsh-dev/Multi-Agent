"""
Initialize Supabase PostgreSQL schema with tables matching the SQLite schema.
Uses direct PostgreSQL connection (DATABASE_URL) to create tables if missing.
"""
import logging
import os

logger = logging.getLogger("visibility-docs")

SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    title TEXT NOT NULL,
    document_type TEXT,
    phase3_agent TEXT,
    status TEXT DEFAULT 'uploaded',
    original_file_url TEXT,
    file_hash TEXT,
    page_count BIGINT,
    language TEXT,
    raw_text TEXT,
    error_message TEXT,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    page_id TEXT,
    chunk_index INTEGER DEFAULT 0,
    chunk_type TEXT DEFAULT 'paragraph',
    heading TEXT,
    section TEXT,
    section_number TEXT,
    machine_id TEXT,
    filename TEXT,
    content TEXT NOT NULL,
    chunk_text TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_embeddings (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    chunk_id INTEGER,
    embedding VECTOR(1024),
    model_name TEXT DEFAULT 'all-MiniLM-L6-v2',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_extractions (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    extraction_type TEXT NOT NULL,
    extracted_data JSONB NOT NULL,
    confidence REAL DEFAULT 0,
    reviewed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON document_embeddings(document_id);

-- Migrate missing columns (safe to re-run)
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS section_number TEXT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS machine_id TEXT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_text TEXT;

CREATE TABLE IF NOT EXISTS documents_metadata (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    extracted_data JSONB NOT NULL DEFAULT '{}',
    field_confidence JSONB DEFAULT '{}',
    overall_confidence REAL DEFAULT 0,
    agent_version TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metadata_doc_id ON documents_metadata(document_id);

CREATE TABLE IF NOT EXISTS processing_jobs (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'full_pipeline',
    stage TEXT DEFAULT 'queued',
    status TEXT DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_doc_id ON processing_jobs(document_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status);

CREATE TABLE IF NOT EXISTS agent_runs (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    input_summary TEXT,
    output_summary TEXT,
    confidence REAL,
    duration_ms INTEGER,
    status TEXT DEFAULT 'completed',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_doc_id ON agent_runs(document_id);

CREATE TABLE IF NOT EXISTS validation_results (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    validation_type TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    target_document_id TEXT,
    source_field TEXT,
    target_field TEXT,
    expected_value TEXT,
    actual_value TEXT,
    match_status TEXT DEFAULT 'pending',
    discrepancy_details TEXT,
    severity TEXT DEFAULT 'info',
    resolved INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_validation_org ON validation_results(organization_id);
CREATE INDEX IF NOT EXISTS idx_validation_source ON validation_results(source_document_id);

CREATE TABLE IF NOT EXISTS workflow_instances (
    id SERIAL PRIMARY KEY,
    organization_id TEXT NOT NULL,
    workflow_type TEXT NOT NULL,
    document_id TEXT NOT NULL,
    current_stage TEXT NOT NULL DEFAULT 'uploaded',
    status TEXT DEFAULT 'active',
    stages JSONB DEFAULT '[]'::jsonb,
    approvals_required INTEGER DEFAULT 0,
    approvals_obtained INTEGER DEFAULT 0,
    assigned_to TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_doc_id ON workflow_instances(document_id);
CREATE INDEX IF NOT EXISTS idx_workflow_status ON workflow_instances(status);

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

CREATE OR REPLACE FUNCTION match_documents(
    query_embedding VECTOR(1024),
    match_threshold FLOAT DEFAULT 0.7,
    match_count INT DEFAULT 10,
    filter_org_id TEXT DEFAULT NULL
)
RETURNS TABLE(
    id INTEGER,
    document_id TEXT,
    organization_id TEXT,
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
    WHERE (filter_org_id IS NULL OR dc.organization_id = filter_org_id)
      AND (1 - (de.embedding <=> query_embedding)) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION delete_document_cascade(p_document_id TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM document_chunks WHERE document_id = p_document_id;
    DELETE FROM document_embeddings WHERE document_id = p_document_id;
    DELETE FROM document_extractions WHERE document_id = p_document_id;
    DELETE FROM documents_metadata WHERE document_id = p_document_id;
    DELETE FROM processing_jobs WHERE document_id = p_document_id;
    DELETE FROM agent_runs WHERE document_id = p_document_id;
    DELETE FROM validation_results WHERE source_document_id = p_document_id;
    DELETE FROM workflow_instances WHERE document_id = p_document_id;
    DELETE FROM documents WHERE id = p_document_id;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    hashed_password TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(organization_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT,
    document_ids JSONB DEFAULT '[]'::jsonb,
    title TEXT NOT NULL DEFAULT 'New Chat',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS document_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_org ON chat_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    sources JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS phase3_agent TEXT;

CREATE TABLE IF NOT EXISTS user_profiles (
    id SERIAL PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    organization_id TEXT NOT NULL DEFAULT 'default-org',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
"""


def init_supabase_schema(database_url: str) -> bool:
    if not database_url:
        return False
    try:
        import psycopg2
        conn = psycopg2.connect(database_url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(SCHEMA_SQL)
        try:
            cur.execute("NOTIFY pgrst, 'reload schema'")
        except Exception:
            pass
        cur.close()
        conn.close()
        logger.info("Supabase schema initialized successfully")
        return True
    except Exception as e:
        logger.warning(f"Could not init Supabase schema: {e}")
        return False
