import logging
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .auth.service import decode_access_token
from .database import get_user_by_id
from .config import settings

logger = logging.getLogger("visibility-docs")
security = HTTPBearer(auto_error=False)


async def get_internal_or_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    """Resolve the caller to a trusted principal.

    Two trusted identities are accepted:
      1. The api-gateway, which signs every request with `X-Internal-Service-Key`
         (the shared secret from settings.INTERNAL_SERVICE_KEY). The gateway has
         already enforced RBAC, so its calls are treated as internal and trusted.
      2. A directly-authenticated user (valid JWT). For these the caller's
         permission set comes from the token; Tier-3 tools require an override.

    Returns a dict with:
      { "source": "internal" | "user", "user_id": ..., "org_id": ..., "permissions": [...] }
    Raises 401 if neither identity can be established. Use this on endpoints
    that mutate state or otherwise must not be reachable anonymously.
    """
    key = request.headers.get("X-Internal-Service-Key", "")
    if key and settings.INTERNAL_SERVICE_KEY and key == settings.INTERNAL_SERVICE_KEY:
        return {
            "source": "internal",
            "user_id": "api-gateway",
            "org_id": None,  # gateway passes org via query/body
            "permissions": None,  # trust the gateway's RBAC decision
        }

    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    org_id = payload.get("org_id", "default-org")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    perms = payload.get("permissions") or []
    if not isinstance(perms, list):
        perms = []
    return {"source": "user", "user_id": user_id, "org_id": org_id, "permissions": perms}


async def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    email = payload.get("email", "")
    org_id = payload.get("org_id", "")
    if not user_id or not org_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return {"user_id": user_id, "email": email, "org_id": org_id}


async def get_optional_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None:
        return None
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        return None
    user_id = payload.get("sub")
    org_id = payload.get("org_id", "default-org")
    email = payload.get("email", "")
    return {"user_id": user_id, "email": email, "org_id": org_id}
