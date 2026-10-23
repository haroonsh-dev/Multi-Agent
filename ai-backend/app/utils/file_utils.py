import os
import uuid
import hashlib
import re
from pathlib import Path
from fastapi import UploadFile
from ..config import settings
from ..database import SupabaseDB
from ..services.hf_storage import hf_storage

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp", ".docx", ".xlsx", ".pptx", ".txt"}
MAX_FILE_SIZE = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024


def resolve_shared_storage_root() -> str:
    configured = (settings.SHARED_STORAGE_PATH or os.getenv("SHARED_STORAGE_PATH", "")).strip()
    if configured:
        return os.path.abspath(configured)
    ai_backend_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(os.path.dirname(ai_backend_root), "shared-storage")


def is_path_under_root(candidate: str, root: str) -> bool:
    try:
        abs_candidate = os.path.abspath(candidate)
        abs_root = os.path.abspath(root)
        return os.path.commonpath([abs_candidate, abs_root]) == abs_root
    except ValueError:
        return False


def file_info_from_local_path(local_path: str, organization_id: str, original_name: str = "") -> dict:
    root = resolve_shared_storage_root()
    abs_path = os.path.abspath(local_path)
    if not is_path_under_root(abs_path, root):
        raise ValueError(f"File path must be under shared storage: {root}")
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"File not found: {abs_path}")

    with open(abs_path, "rb") as f:
        file_data = f.read()

    if len(file_data) > MAX_FILE_SIZE:
        raise ValueError(f"File too large. Max size: {settings.MAX_UPLOAD_SIZE_MB}MB")

    rel_path = os.path.relpath(abs_path, root).replace("\\", "/")
    return {
        "org_id": organization_id,
        "filename": rel_path,
        "original_name": original_name or os.path.basename(abs_path),
        "file_path": abs_path,
        "file_size": len(file_data),
        "file_hash": get_file_hash(file_data),
        "content_type": "application/octet-stream",
        "supabase_url": "",
    }


def is_allowed_file(filename: str) -> bool:
    ext = Path(filename).suffix.lower()
    return ext in ALLOWED_EXTENSIONS


def get_file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_unique_filename(original: str) -> str:
    if not original:
        return f"file_{uuid.uuid4().hex[:8]}"
    safe = re.sub(r'[^a-zA-Z0-9._-]', '_', original)
    safe = safe.strip().strip('.')
    safe = safe[:200]
    if not safe:
        safe = f"file_{uuid.uuid4().hex[:8]}"
    return safe


def _save_bytes_to_shared_storage(
    file_data: bytes,
    organization_id: str,
    filename: str,
    content_type: str,
    original_name: str,
) -> dict:
    root = resolve_shared_storage_root()
    org_segment = organization_id or "default"
    dest_dir = os.path.join(root, "orgs", org_segment, "incoming")
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception:
        fallback_root = os.path.abspath(settings.UPLOAD_DIR or "uploads")
        dest_dir = os.path.join(fallback_root, "orgs", org_segment, "incoming")
        os.makedirs(dest_dir, exist_ok=True)
        root = fallback_root

    local_path = os.path.abspath(os.path.join(dest_dir, filename))
    with open(local_path, "wb") as f:
        f.write(file_data)

    rel_path = os.path.relpath(local_path, root).replace("\\", "/")
    remote_path = f"{org_segment}/{filename}"

    supabase_url = ""
    cloud_path = ""
    if settings.USE_CLOUD_FILE_STORAGE:
        hf_url = hf_storage.upload_bytes(file_data, remote_path)
        try:
            SupabaseDB.upload_file("documents", remote_path, file_data, content_type)
            if settings.SUPABASE_URL:
                supabase_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/documents/{remote_path}"
        except Exception:
            pass
        cloud_path = hf_url or supabase_url

    return {
        "org_id": organization_id,
        "filename": rel_path,
        "original_name": original_name,
        "file_path": local_path,
        "file_size": len(file_data),
        "file_hash": get_file_hash(file_data),
        "content_type": content_type,
        "supabase_url": cloud_path,
    }


async def save_upload_file(upload_file: UploadFile, organization_id: str = "") -> dict:
    file_data = await upload_file.read()

    if len(file_data) > MAX_FILE_SIZE:
        raise ValueError(f"File too large. Max size: {settings.MAX_UPLOAD_SIZE_MB}MB")

    filename = generate_unique_filename(upload_file.filename)
    return _save_bytes_to_shared_storage(
        file_data,
        organization_id,
        filename,
        upload_file.content_type or "application/octet-stream",
        upload_file.filename or filename,
    )
