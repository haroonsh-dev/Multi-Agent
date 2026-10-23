import os
import json
import sqlite3
import threading
from datetime import datetime
from typing import Any, Optional
from .config import settings

_local = threading.local()
_use_supabase = False
_supabase_client = None
_supabase_tried = False


def _get_supabase():
    global _supabase_client, _use_supabase, _supabase_tried
    if _supabase_tried:
        return _supabase_client
    _supabase_tried = True
    url = settings.SUPABASE_URL or os.getenv("SUPABASE_URL", "")
    key = settings.SUPABASE_KEY or os.getenv("SUPABASE_KEY", "")
    if (url and key and url != "your_supabase_url"
            and not url.startswith("https://test") and not url.startswith("http://test")):
        try:
            from supabase import create_client
            from supabase.lib.client_options import SyncClientOptions
            opts = SyncClientOptions(postgrest_client_timeout=30)
            _supabase_client = create_client(url, key, options=opts)
            _use_supabase = True
        except Exception:
            _supabase_client = None
    return _supabase_client


def _get_local_db():
    if not hasattr(_local, "conn") or _local.conn is None:
        db_path = os.path.join(settings.UPLOAD_DIR, "..", "docs_ai.db")
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_local_db(conn)
        except Exception:
            conn.close()
            raise
        _local.conn = conn
    return _local.conn


def _init_local_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            document_type TEXT,
            phase3_agent TEXT,
            status TEXT DEFAULT 'uploaded',
            original_file_url TEXT,
            file_hash TEXT,
            page_count INTEGER,
            file_size INTEGER,
            language TEXT,
            raw_text TEXT,
            error_message TEXT,
            uploaded_by TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS document_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            metadata TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS document_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            chunk_id INTEGER,
            embedding BLOB,
            model_name TEXT DEFAULT 'all-MiniLM-L6-v2',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS document_extractions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            extraction_type TEXT NOT NULL,
            extracted_data TEXT NOT NULL,
            confidence REAL DEFAULT 0,
            reviewed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS documents_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            document_type TEXT NOT NULL,
            extracted_data TEXT DEFAULT '{}',
            field_confidence TEXT DEFAULT '{}',
            overall_confidence REAL DEFAULT 0,
            agent_version TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS processing_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            job_type TEXT DEFAULT 'full_pipeline',
            stage TEXT DEFAULT 'queued',
            status TEXT DEFAULT 'queued',
            progress INTEGER DEFAULT 0,
            error_message TEXT,
            started_at TEXT,
            completed_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            input_summary TEXT,
            output_summary TEXT,
            confidence REAL,
            duration_ms INTEGER,
            status TEXT DEFAULT 'completed',
            error_message TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS validation_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at TEXT DEFAULT (datetime('now')),
            resolved_at TEXT
        );
        CREATE TABLE IF NOT EXISTS workflow_instances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            workflow_type TEXT NOT NULL,
            document_id TEXT NOT NULL,
            current_stage TEXT DEFAULT 'uploaded',
            status TEXT DEFAULT 'active',
            stages TEXT DEFAULT '[]',
            approvals_required INTEGER DEFAULT 0,
            approvals_obtained INTEGER DEFAULT 0,
            assigned_to TEXT,
            metadata TEXT DEFAULT '{}',
            error_message TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_tool_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            agent_id TEXT,
            user_id TEXT,
            risk_tier TEXT DEFAULT 'read',
            decision TEXT DEFAULT 'allow',
            input_payload TEXT,
            result_status TEXT DEFAULT 'started',
            result_summary TEXT,
            duration_ms INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_org ON agent_tool_audit(organization_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_tool ON agent_tool_audit(tool_name);
        CREATE INDEX IF NOT EXISTS idx_doc_org ON documents(organization_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_org ON document_chunks(organization_id);
        CREATE INDEX IF NOT EXISTS idx_emb_doc ON document_embeddings(document_id);
        CREATE INDEX IF NOT EXISTS idx_emb_chunk ON document_embeddings(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_doc_type ON documents(document_type);
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            user_id TEXT,
            document_ids TEXT DEFAULT '[]',
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_org ON chat_sessions(organization_id);
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            sources TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
        CREATE TABLE IF NOT EXISTS user_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE NOT NULL,
            email TEXT NOT NULL,
            organization_id TEXT NOT NULL DEFAULT 'default-org',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
    """)
    # Migrations for older local DBs (CREATE TABLE IF NOT EXISTS will not add new columns)
    for stmt in (
        "ALTER TABLE document_chunks ADD COLUMN chunk_text TEXT",
        "ALTER TABLE documents ADD COLUMN phase3_agent TEXT",
        "ALTER TABLE documents ADD COLUMN allowed_agents TEXT",
        "ALTER TABLE documents ADD COLUMN natural_agent TEXT",
        "ALTER TABLE documents ADD COLUMN agent_clamped INTEGER DEFAULT 0",
        "ALTER TABLE chat_sessions ADD COLUMN user_id TEXT",
        "ALTER TABLE document_chunks ADD COLUMN section TEXT",
        "ALTER TABLE document_chunks ADD COLUMN section_number TEXT",
        "ALTER TABLE document_chunks ADD COLUMN machine_id TEXT",
        "ALTER TABLE document_chunks ADD COLUMN filename TEXT",
    ):
        try:
            conn.execute(stmt)
        except Exception:
            pass
    # Indexes that depend on migrated columns
    for stmt in (
        "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)",
    ):
        try:
            conn.execute(stmt)
        except Exception:
            pass
    try:
        conn.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content, document_id UNINDEXED, organization_id UNINDEXED, page_id UNINDEXED
            );
        """)
    except Exception:
        pass
    try:
        conn.commit()
    except Exception:
        pass


class SupabaseDB:
    @staticmethod
    def insert(table: str, data: dict):
        supabase_ok = False
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.table(table).insert(data).execute()
                supabase_ok = True
        except Exception as e:
            print(f"[SupabaseDB.insert ERROR] Failed to insert into {table}: {e}")
        local = _local_insert(table, data)
        return local if not supabase_ok else type("Result", (), {"data": [data]})()

    @staticmethod
    def update(table: str, data: dict, id_column: str, id_value: str):
        supabase_ok = False
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.table(table).update(data).eq(id_column, id_value).execute()
                supabase_ok = True
        except Exception:
            pass
        local = _local_update(table, data, id_column, id_value)
        return local if not supabase_ok else type("Result", (), {"data": [data]})()

    @staticmethod
    def delete_document_cascade(document_id: str):
        cascade_tables = ["document_chunks", "document_embeddings", "document_extractions",
                          "documents_metadata", "processing_jobs", "agent_runs",
                          "workflow_instances"]
        try:
            client = _get_supabase()
            if _use_supabase and client:
                for tbl in cascade_tables:
                    client.table(tbl).delete().eq("document_id", document_id).execute()
                client.table("validation_results").delete().eq("source_document_id", document_id).execute()
                client.table("documents").delete().eq("id", document_id).execute()
        except Exception:
            pass
        conn = _get_local_db()
        conn.execute("BEGIN")
        try:
            for tbl in cascade_tables:
                conn.execute(f"DELETE FROM {tbl} WHERE document_id=?", (document_id,))
            conn.execute("DELETE FROM validation_results WHERE source_document_id=?", (document_id,))
            conn.execute("DELETE FROM documents WHERE id=?", (document_id,))
            conn.commit()
        except Exception:
            conn.rollback()

    @staticmethod
    def select(table: str, columns: str = "*", filters: dict = None, like: dict = None, limit: int = None, offset: int = None):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                query = client.table(table).select(columns)
                if filters:
                    for key, value in filters.items():
                        query = query.eq(key, value)
                if like:
                    for key, value in like.items():
                        query = query.ilike(key, f"%{value}%")
                if limit:
                    query = query.limit(limit)
                if offset:
                    query = query.offset(offset)
                result = query.execute()
                if getattr(result, "data", None) is not None and len(result.data) > 0:
                    return result
        except Exception:
            pass
        return _local_select(table, columns, filters, like, limit, offset)

    @staticmethod
    def batch_insert(table: str, records: list[dict]) -> list[dict]:
        supabase_data = []
        try:
            client = _get_supabase()
            if _use_supabase and client:
                res = client.table(table).insert(records).execute()
                if hasattr(res, 'error') and res.error:
                    print(f"[DB] batch_insert {table} error: {res.error}")
                else:
                    supabase_data = getattr(res, "data", []) or []
        except Exception as e:
            print(f"[DB] batch_insert {table} exception: {e}")
        local_ids = _local_batch_insert(table, records)
        # Fall back to local IDs if Supabase returned no data
        if not supabase_data and local_ids:
            supabase_data = [{"id": rid} for rid in local_ids]
        return supabase_data

    @staticmethod
    def upload_file(bucket: str, path: str, file_data: bytes, content_type: str = None):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                return client.storage.from_(bucket).upload(path, file_data, {"content-type": content_type or "application/octet-stream"})
        except Exception:
            pass
        return None

    @staticmethod
    def delete_file(bucket: str, path: str):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.storage.from_(bucket).remove([path])
        except Exception:
            pass

    @staticmethod
    def search_vector(table: str, query_vector: list, match_threshold: float = 0.7, match_count: int = 10, filter_org_id: str = None):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                params = {"query_embedding": query_vector, "match_threshold": match_threshold, "match_count": match_count}
                if filter_org_id:
                    params["filter_org_id"] = filter_org_id
                result = client.rpc("match_documents", params).execute()
                if result.data:
                    return result
        except Exception:
            pass
        return _local_search_vector(query_vector, match_threshold, match_count, filter_org_id)

    @staticmethod
    def create_chat_session(
        organization_id: str,
        title: str = "New Chat",
        document_ids: list = None,
        user_id: str = None,
    ) -> str:
        import uuid
        session_id = uuid.uuid4().hex
        doc_list = document_ids or []
        doc_ids_json = __import__("json").dumps(doc_list)
        now = datetime.utcnow().isoformat()
        try:
            client = _get_supabase()
            if _use_supabase and client:
                row = {
                    "id": session_id,
                    "organization_id": organization_id,
                    "title": title,
                    "document_ids": doc_list,
                    "created_at": now,
                    "updated_at": now,
                }
                if user_id:
                    row["user_id"] = user_id
                client.table("chat_sessions").insert(row).execute()
        except Exception:
            pass
        conn = _get_local_db()
        conn.execute(
            "INSERT INTO chat_sessions (id, organization_id, user_id, document_ids, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (session_id, organization_id, user_id, doc_ids_json, title, now, now),
        )
        conn.commit()
        return session_id

    @staticmethod
    def list_chat_sessions(
        organization_id: str,
        document_id: str = None,
        user_id: str = None,
    ) -> list[dict]:
        try:
            client = _get_supabase()
            if _use_supabase and client:
                query = (
                    client.table("chat_sessions")
                    .select("*")
                    .eq("organization_id", organization_id)
                    .order("updated_at", desc=True)
                )
                if user_id:
                    query = query.eq("user_id", user_id)
                result = query.execute()
                if result.data:
                    rows = result.data
                    for r in rows:
                        if isinstance(r.get("document_ids"), str):
                            try:
                                r["document_ids"] = __import__("json").loads(r["document_ids"])
                            except Exception:
                                r["document_ids"] = []
                    return rows
        except Exception:
            pass
        conn = _get_local_db()
        if user_id:
            rows = conn.execute(
                "SELECT * FROM chat_sessions WHERE organization_id=? AND user_id=? ORDER BY updated_at DESC",
                (organization_id, user_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM chat_sessions WHERE organization_id=? ORDER BY updated_at DESC",
                (organization_id,),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("document_ids"), str):
                try:
                    d["document_ids"] = __import__("json").loads(d["document_ids"])
                except Exception:
                    d["document_ids"] = []
            result.append(d)
        return result

    @staticmethod
    def get_chat_session(session_id: str) -> dict | None:
        try:
            client = _get_supabase()
            if _use_supabase and client:
                result = client.table("chat_sessions").select("*").eq("id", session_id).single().execute()
                if getattr(result, "data", None):
                    d = result.data
                    if isinstance(d.get("document_ids"), str):
                        try:
                            d["document_ids"] = __import__("json").loads(d["document_ids"])
                        except Exception:
                            d["document_ids"] = []
                    msgs = client.table("chat_messages").select("*").eq("session_id", session_id).order("created_at", asc=True).execute()
                    msg_data = getattr(msgs, "data", [])
                    for m in msg_data:
                        if m.get("sources") and isinstance(m["sources"], str):
                            try:
                                m["sources"] = __import__("json").loads(m["sources"])
                            except Exception:
                                pass
                    return {**d, "messages": msg_data}
        except Exception:
            pass
        conn = _get_local_db()
        row = conn.execute("SELECT * FROM chat_sessions WHERE id=?", (session_id,)).fetchone()
        if row:
            d = dict(row)
            if isinstance(d.get("document_ids"), str):
                try:
                    d["document_ids"] = __import__("json").loads(d["document_ids"])
                except Exception:
                    d["document_ids"] = []
            ms = conn.execute("SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at ASC", (session_id,)).fetchall()
            msg_list = []
            for m in ms:
                md = dict(m)
                if md.get("sources"):
                    try:
                        md["sources"] = __import__("json").loads(md["sources"])
                    except Exception:
                        pass
                msg_list.append(md)
            d["messages"] = msg_list
            return d
        return None

    @staticmethod
    def save_chat_message(session_id: str, role: str, content: Any, sources: list = None) -> int:
        if isinstance(content, dict):
            content = str(content.get("answer") or content)
        elif not isinstance(content, str):
            content = str(content) if content is not None else ""
        try:
            client = _get_supabase()
            if _use_supabase and client:
                data = {"session_id": session_id, "role": role, "content": content}
                if role == "assistant" and sources:
                    data["sources"] = sources
                client.table("chat_messages").insert(data).execute()
                client.table("chat_sessions").update({"updated_at": datetime.utcnow().isoformat()}).eq("id", session_id).execute()
        except Exception:
            pass
        conn = _get_local_db()
        sources_json = __import__("json").dumps(sources) if role == "assistant" and sources else None
        cur = conn.execute("INSERT INTO chat_messages (session_id, role, content, sources) VALUES (?,?,?,?)",
                           (session_id, role, content, sources_json))
        conn.execute("UPDATE chat_sessions SET updated_at=? WHERE id=?", (datetime.utcnow().isoformat(), session_id))
        conn.commit()
        return cur.lastrowid or 0

    @staticmethod
    def update_chat_session_title(session_id: str, title: str):
        now = datetime.utcnow().isoformat()
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.table("chat_sessions").update({"title": title, "updated_at": now}).eq("id", session_id).execute()
        except Exception:
            pass
        conn = _get_local_db()
        conn.execute("UPDATE chat_sessions SET title=?, updated_at=? WHERE id=?", (title, now, session_id))
        conn.commit()

    @staticmethod
    def update_chat_session_doc_ids(session_id: str, document_ids: list):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.table("chat_sessions").update({"document_ids": document_ids}).eq("id", session_id).execute()
        except Exception:
            pass
        conn = _get_local_db()
        doc_ids_json = __import__("json").dumps(document_ids)
        conn.execute("UPDATE chat_sessions SET document_ids=? WHERE id=?", (doc_ids_json, session_id))
        conn.commit()

    @staticmethod
    def delete_chat_session(session_id: str):
        try:
            client = _get_supabase()
            if _use_supabase and client:
                client.table("chat_messages").delete().eq("session_id", session_id).execute()
                client.table("chat_sessions").delete().eq("id", session_id).execute()
        except Exception:
            pass
        conn = _get_local_db()
        conn.execute("DELETE FROM chat_messages WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM chat_sessions WHERE id=?", (session_id,))
        conn.commit()


def create_user(user_id: str, email: str, hashed_password: str, organization_id: str) -> dict:
    try:
        client = _get_supabase()
        if _use_supabase and client:
            result = client.table("users").insert({
                "id": user_id, "email": email, "hashed_password": hashed_password,
                "organization_id": organization_id,
            }).execute()
            if result.data:
                return result.data[0]
    except Exception:
        pass
    conn = _get_local_db()
    conn.execute("INSERT OR REPLACE INTO users (id, email, hashed_password, organization_id) VALUES (?,?,?,?)",
                 (user_id, email, hashed_password, organization_id))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else {"id": user_id, "email": email, "organization_id": organization_id}


def get_user_by_email(email: str) -> dict | None:
    try:
        client = _get_supabase()
        if _use_supabase and client:
            result = client.table("users").select("*").eq("email", email).maybe_single().execute()
            if getattr(result, "data", None):
                return result.data
    except Exception:
        pass
    conn = _get_local_db()
    row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    try:
        client = _get_supabase()
        if _use_supabase and client:
            result = client.table("users").select("*").eq("id", user_id).maybe_single().execute()
            if getattr(result, "data", None):
                return result.data
    except Exception:
        pass
    conn = _get_local_db()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def _local_insert(table: str, data: dict):
    conn = _get_local_db()
    if table == "documents":
        data["id"] = data.get("id", __import__("uuid").uuid4().hex)
        conn.execute("INSERT OR REPLACE INTO documents (id, organization_id, title, document_type, status, original_file_url, file_hash, page_count, file_size, language, raw_text, error_message, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (data["id"], data.get("organization_id", ""), data.get("title", ""), data.get("document_type"), data.get("status", "uploaded"),
                      data.get("original_file_url"), data.get("file_hash"), data.get("page_count"), data.get("file_size"),
                      data.get("language"), data.get("raw_text"), data.get("error_message"), data.get("uploaded_by", "")))
        conn.commit()
        return type("Result", (), {"data": [dict(conn.execute("SELECT * FROM documents WHERE id=?", (data["id"],)).fetchone())]})()
    if table == "document_chunks":
        cur = conn.execute("INSERT INTO document_chunks (organization_id, document_id, page_id, chunk_type, heading, section, section_number, machine_id, filename, content, chunk_text, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("page_id"), data.get("chunk_type", "paragraph"),
                            data.get("heading"), data.get("section"), data.get("section_number"), data.get("machine_id"), data.get("filename"),
                            data.get("content", ""), data.get("chunk_text") or data.get("content", ""),
                            __import__("json").dumps(data.get("metadata")) if data.get("metadata") else None))
        conn.commit()
        chunk_id = cur.lastrowid
        _local_fts_sync(data.get("document_id"))
        return type("Result", (), {"data": [{**data, "id": chunk_id}]})()
    if table == "document_embeddings":
        cur = conn.execute("INSERT INTO document_embeddings (organization_id, document_id, chunk_id, embedding, model_name) VALUES (?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("chunk_id"),
                            str(data.get("embedding", [])), data.get("model_name", "all-MiniLM-L6-v2")))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "document_extractions":
        cur = conn.execute("INSERT INTO document_extractions (organization_id, document_id, extraction_type, extracted_data, confidence) VALUES (?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("extraction_type", ""),
                            __import__("json").dumps(data.get("extracted_data", {})), data.get("confidence", 0.0)))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "documents_metadata":
        cur = conn.execute("INSERT INTO documents_metadata (organization_id, document_id, document_type, extracted_data, field_confidence, overall_confidence, agent_version) VALUES (?,?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("document_type", ""),
                            __import__("json").dumps(data.get("extracted_data", {})),
                            __import__("json").dumps(data.get("field_confidence", {})),
                            data.get("overall_confidence", 0.0), data.get("agent_version")))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "processing_jobs":
        cur = conn.execute("INSERT INTO processing_jobs (organization_id, document_id, job_type, stage, status, progress) VALUES (?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("job_type", "full_pipeline"),
                            data.get("stage", "queued"), data.get("status", "queued"), data.get("progress", 0)))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "agent_tool_audit":
        cur = conn.execute(
            "INSERT INTO agent_tool_audit (organization_id, tool_name, agent_id, user_id, risk_tier, decision, input_payload, result_status, result_summary, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (data.get("organization_id", ""), data.get("tool_name", ""), data.get("agent_id", ""),
             data.get("user_id", ""), data.get("risk_tier", "read"), data.get("decision", "allow"),
             data.get("input_payload"), data.get("result_status", "started"),
             data.get("result_summary", ""), data.get("duration_ms"), data.get("created_at")),
        )
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "agent_runs":
        cur = conn.execute("INSERT INTO agent_runs (organization_id, document_id, agent_name, input_summary, output_summary, confidence, duration_ms, status, error_message) VALUES (?,?,?,?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("document_id", ""), data.get("agent_name", ""),
                            data.get("input_summary"), data.get("output_summary"), data.get("confidence"),
                            data.get("duration_ms"), data.get("status", "completed"), data.get("error_message")))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "validation_results":
        cur = conn.execute("INSERT INTO validation_results (organization_id, validation_type, source_document_id, target_document_id, source_field, target_field, expected_value, actual_value, match_status, discrepancy_details, severity) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("validation_type", ""), data.get("source_document_id", ""),
                            data.get("target_document_id"), data.get("source_field"), data.get("target_field"),
                            data.get("expected_value"), data.get("actual_value"), data.get("match_status", "pending"),
                            data.get("discrepancy_details"), data.get("severity", "info")))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    if table == "workflow_instances":
        cur = conn.execute("INSERT INTO workflow_instances (organization_id, workflow_type, document_id, current_stage, status, stages, approvals_required, approvals_obtained, assigned_to, metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (data.get("organization_id", ""), data.get("workflow_type", ""), data.get("document_id", ""),
                            data.get("current_stage", "uploaded"), data.get("status", "active"),
                            __import__("json").dumps(data.get("stages", [])), data.get("approvals_required", 0),
                            data.get("approvals_obtained", 0), data.get("assigned_to"),
                            __import__("json").dumps(data.get("metadata", {}))))
        conn.commit()
        return type("Result", (), {"data": [{**data, "id": cur.lastrowid}]})()
    return type("Result", (), {"data": [data]})()


def _local_update(table: str, data: dict, id_column: str, id_value: str):
    conn = _get_local_db()
    sets = ", ".join(f"{k}=?" for k in data.keys())
    values = list(data.values()) + [id_value]
    conn.execute(f"UPDATE {table} SET {sets} WHERE {id_column}=?", values)
    conn.commit()
    return type("Result", (), {"data": [data]})()


def _local_delete(table: str, id_column: str, id_value: str):
    conn = _get_local_db()
    conn.execute(f"DELETE FROM {table} WHERE {id_column}=?", (id_value,))
    conn.commit()
    return type("Result", (), {"data": []})()


def _local_select(table: str, columns: str = "*", filters: dict = None, like: dict = None, limit: int = None, offset: int = None):
    conn = _get_local_db()
    query = f"SELECT {columns} FROM {table}"
    params = []
    where_clauses = []
    if filters:
        for k, v in filters.items():
            where_clauses.append(f"{k}=?")
            params.append(v)
    if like:
        for k, v in like.items():
            where_clauses.append(f"{k} LIKE ?")
            params.append(f"%{v}%")
    if where_clauses:
        query += " WHERE " + " AND ".join(where_clauses)
    if limit:
        query += f" LIMIT {limit}"
    if offset:
        query += f" OFFSET {offset}"
    rows = conn.execute(query, params).fetchall()
    return type("Result", (), {"data": [dict(r) for r in rows]})()


def _local_batch_insert(table: str, records: list[dict]) -> list[int]:
    conn = _get_local_db()
    ids = []
    if table == "document_chunks":
        doc_ids = set()
        cursor = conn.executemany(
            "INSERT INTO document_chunks (organization_id, document_id, page_id, chunk_type, heading, section, section_number, machine_id, filename, content, chunk_text, chunk_index, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(r.get("organization_id", ""), r.get("document_id", ""), r.get("page_id"),
              r.get("chunk_type", "paragraph"), r.get("heading"),
              r.get("section"), r.get("section_number"), r.get("machine_id"), r.get("filename"),
              r.get("content", ""), r.get("chunk_text") or r.get("content", ""),
              r.get("chunk_index", 0), __import__("json").dumps(r.get("metadata")) if r.get("metadata") else None) for r in records])
        # Get lastrowid for each inserted record (they are sequential)
        try:
            last_id = cursor.lastrowid
            if last_id:
                ids = list(range(last_id - len(records) + 1, last_id + 1))
        except Exception:
            pass
        for r in records:
            if r.get("document_id"):
                doc_ids.add(r["document_id"])
        conn.commit()
        for did in doc_ids:
            _local_fts_sync(did)
    elif table == "document_embeddings":
        conn.executemany(
            "INSERT INTO document_embeddings (organization_id, document_id, chunk_id, embedding, model_name) VALUES (?,?,?,?,?)",
            [(r.get("organization_id", ""), r.get("document_id", ""), r.get("chunk_id"),
              str(r.get("embedding", [])), r.get("model_name", "all-MiniLM-L6-v2")) for r in records])
        conn.commit()
    return ids


def _local_select_in(table: str, columns: str = "*", filters: dict = None, in_column: str = None, in_values: list = None):
    conn = _get_local_db()
    query = f"SELECT {columns} FROM {table}"
    params = []
    where_clauses = []
    if filters:
        for k, v in filters.items():
            where_clauses.append(f"{k}=?")
            params.append(v)
    if in_column and in_values:
        placeholders = ",".join("?" * len(in_values))
        where_clauses.append(f"{in_column} IN ({placeholders})")
        params.extend(in_values)
    if where_clauses:
        query += " WHERE " + " AND ".join(where_clauses)
    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def _local_fts_sync(document_id: str = None):
    conn = _get_local_db()
    try:
        if document_id:
            conn.execute("DELETE FROM chunks_fts WHERE document_id=?", (document_id,))
            rows = conn.execute("SELECT id, content, chunk_text, document_id, organization_id, page_id FROM document_chunks WHERE document_id=?", (document_id,)).fetchall()
        else:
            conn.execute("DELETE FROM chunks_fts")
            rows = conn.execute("SELECT id, content, chunk_text, document_id, organization_id, page_id FROM document_chunks").fetchall()
        for r in rows:
            try:
                row = dict(r)
                fts_parts = []
                if row.get("content"):
                    fts_parts.append(str(row["content"]))
                if row.get("chunk_text") and row.get("chunk_text") != row.get("content"):
                    fts_parts.append(str(row["chunk_text"]))
                # Include heading text so label-based invoice queries can match.
                heading = row.get("heading")
                if heading:
                    fts_parts.insert(0, str(heading))
                fts_content = "\n".join(fts_parts) if fts_parts else ""
                conn.execute("INSERT INTO chunks_fts (rowid, content, document_id, organization_id, page_id) VALUES (?, ?, ?, ?, ?)",
                             (row["id"], fts_content, row["document_id"], row["organization_id"], row["page_id"]))
            except Exception:
                pass
        conn.commit()
    except Exception:
        pass


def _local_keyword_search(query: str, organization_id: str = None, limit: int = 10, offset: int = 0) -> list[dict]:
    conn = _get_local_db()
    try:
        # Sanitize FTS5 query: escape special characters, wrap terms for prefix matching
        import re
        cleaned = re.sub(r'[^\w\s]', ' ', query).strip()
        terms = [t for t in cleaned.split() if t]
        if not terms:
            return []
        # High-recall FTS5: phrase match (precision) OR per-term match (recall)
        term_queries = " OR ".join(f'"{t}"*' for t in terms)
        if len(terms) > 1:
            phrase = " ".join(terms)
            fts_query = f'"{phrase}"* OR {term_queries}'
        else:
            fts_query = term_queries

        sql = "SELECT c.rowid, c.*, rank FROM chunks_fts c WHERE c.content MATCH ?"
        params = [fts_query]
        if organization_id:
            sql += " AND c.organization_id=?"
            params.append(organization_id)
        sql += " ORDER BY rank LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _local_search_vector(query_vector: list, match_threshold: float = 0.7, match_count: int = 10, filter_org_id: str = None):
    result_data = []
    try:
        conn = _get_local_db()
        import ast
        rows = conn.execute(
            "SELECT c.*, e.embedding FROM document_chunks c "
            "LEFT JOIN document_embeddings e ON e.chunk_id = c.id "
            "WHERE e.embedding IS NOT NULL"
        ).fetchall()
        if not rows:
            return type("Result", (), {"data": []})()
        scores = []
        for row in rows:
            row = dict(row)
            raw = row["embedding"]
            try:
                stored = list(raw)
            except TypeError:
                stored = ast.literal_eval(raw)
            dot = sum(a * b for a, b in zip(query_vector, stored))
            if len(stored) != len(query_vector):
                continue
            norm = (sum(a * a for a in stored) ** 0.5) * (sum(b * b for b in query_vector) ** 0.5)
            score = dot / norm if norm > 0 else 0
            if score >= match_threshold:
                if filter_org_id and row.get("organization_id") != filter_org_id:
                    continue
                row.pop("embedding", None)
                scores.append((score, row))
        scores.sort(key=lambda x: x[0], reverse=True)
        for score, row in scores[:match_count]:
            result_data.append({**row, "similarity": score})
    except Exception:
        pass
    return type("Result", (), {"data": result_data})()
