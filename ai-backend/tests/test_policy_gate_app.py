"""HTTP-level regression tests for the policy gate + auth gating.

These boot the FastAPI app, so they need the full ai-backend dependency set
(pip install -r requirements.txt). They cover the security surface the gateway
and frontend actually talk to:

  - the agents/catalog router is gated (401 without / with wrong internal key)
  - the policy-check endpoint fails CLOSED for unknown tools (decision blocked)
  - a Tier-3 mutation is denied for a direct-JWT user without an override

Run with a configured (or absent) Supabase — the local SQLite fallback handles
the audit writes when no credentials are present:

    cd ai-backend && python -m pytest tests/test_policy_gate_app.py -q
"""
import pytest

pytest.importorskip("fastapi.testclient")

from fastapi.testclient import TestClient
from jose import jwt

from app.config import settings
from app.main import app

KEY = settings.INTERNAL_SERVICE_KEY
ALG = settings.ALGORITHM
SECRET = settings.SECRET_KEY


def _user_token(permissions=None):
    return jwt.encode(
        {"sub": "test-user", "org_id": "org1", "permissions": permissions or []},
        SECRET,
        algorithm=ALG,
    )


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# --- agents router gating --------------------------------------------------


def test_catalog_requires_internal_key(client):
    assert client.get("/api/v1/agents/catalog").status_code == 401


def test_catalog_wrong_key_rejected(client):
    r = client.get("/api/v1/agents/catalog", headers={"X-Internal-Service-Key": "nope"})
    assert r.status_code == 401


def test_catalog_ok_with_internal_key(client):
    r = client.get("/api/v1/agents/catalog", headers={"X-Internal-Service-Key": KEY})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["agent_ids"]  # non-empty catalog


def test_agents_list_gated(client):
    assert client.get("/api/v1/agents").status_code == 401


# --- policy-check endpoint (what the gateway's checkToolPolicy calls) -------


def test_unknown_tool_check_fails_closed(client):
    r = client.post(
        "/api/v1/tools/does.not.exist/check",
        json={"organization_id": "org1"},
        headers={"X-Internal-Service-Key": KEY},
    )
    assert r.status_code == 200
    assert r.json()["data"]["decision"] == "blocked"


def test_known_tool_check_returns_tier(client):
    r = client.post(
        "/api/v1/tools/documents.delete/check",
        json={"organization_id": "org1"},
        headers={"X-Internal-Service-Key": KEY},
    )
    assert r.status_code == 200
    assert r.json()["data"]["risk_tier"] == "high_risk"


# --- mutation gate ----------------------------------------------------------


def test_tier3_mutation_denied_for_user_without_override(client):
    r = client.post(
        "/api/v1/documents/doc-1/workflow/approve",
        params={"organization_id": "org1", "approver": "Alice"},
        headers={"Authorization": f"Bearer {_user_token()}"},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "approval_required"


def test_tier3_mutation_allowed_with_override(client):
    r = client.post(
        "/api/v1/documents/doc-1/workflow/approve",
        params={"organization_id": "org1", "approver": "Alice"},
        headers={"Authorization": f"Bearer {_user_token(['tool.workflow.approve'])}"},
    )
    # Override granted -> the policy gate must NOT block. The workflow service
    # is lenient for a non-existent doc, so the point is the absence of the
    # 403/503 gate response, not the downstream status code.
    assert r.status_code not in (403, 503)
