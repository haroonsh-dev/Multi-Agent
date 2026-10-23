"""Unit tests for the tool-policy gate — the security core of the agent registry.

These import ONLY agent_registry (stdlib + agent_orchestrator) and stub
app.database so the audit trail never touches Supabase or the local SQLite
file. They are the CI regression net for the fail-closed behavior:

  - unknown tools are blocked for every caller (even internal, even override)
  - Tier-3 requires approval unless an override is held
  - Tier-3 is blocked when the audit row cannot be written (fail closed)
  - Tier-2 stays best-effort on audit failure

Run anywhere with just pytest installed:

    cd ai-backend && python -m pytest tests/test_policy_gate.py -q
"""
import sys
from types import SimpleNamespace

import pytest

_audit_rows: list[dict] = []


def _fake_insert(table: str, row: dict):
    _audit_rows.append(row)
    return SimpleNamespace()


from app.services import agent_registry as r  # noqa: E402


@pytest.fixture(autouse=True)
def _stub_db(monkeypatch):
    """Stub app.database for the duration of each test.

    agent_registry lazy-imports `app.database` inside record_tool_invocation,
    so this fake must be in sys.modules before the first CALL. It is scoped to
    the test (monkeypatch restores afterward) so this file never breaks the
    app-boot tests in test_policy_gate_app.py in the same process.
    """
    _audit_rows.clear()
    monkeypatch.setitem(
        sys.modules,
        "app.database",
        SimpleNamespace(SupabaseDB=SimpleNamespace(insert=_fake_insert)),
    )
    yield


# ---------------------------------------------------------------------------
# Unknown tools fail closed
# ---------------------------------------------------------------------------


def test_unknown_tool_evaluates_blocked():
    ev = r.evaluate_tool("does.not.exist")
    assert ev["decision"] == "blocked"
    assert ev["known"] is False
    assert ev["risk_tier"] == "high_risk"


def test_unknown_tool_blocked_even_for_internal_caller():
    with pytest.raises(r.PolicyDenied) as exc:
        r.enforce_tool_policy("does.not.exist", "org1", {"source": "internal"})
    assert exc.value.evaluation["decision"] == "blocked"


def test_unknown_tool_override_cannot_allow():
    principal = {
        "source": "user",
        "user_id": "u",
        "permissions": ["tool.does.not.exist"],
    }
    with pytest.raises(r.PolicyDenied) as exc:
        r.enforce_tool_policy("does.not.exist", "org1", principal)
    assert exc.value.evaluation["decision"] == "blocked"


# ---------------------------------------------------------------------------
# Known tools keep their tier behavior
# ---------------------------------------------------------------------------


def test_tier1_read_auto_allowed():
    assert r.evaluate_tool("documents.search")["decision"] == "allow"


def test_tier2_mutate_allow_with_audit():
    assert r.evaluate_tool("documents.reprocess")["decision"] == "allow_with_audit"


def test_tier3_approval_required_without_override():
    assert r.evaluate_tool("documents.delete")["decision"] == "approval_required"


def test_tier3_allowed_with_override():
    assert r.evaluate_tool("documents.delete", ["tool.documents.delete"])["decision"] == "allow"


def test_internal_tier3_allow_with_audit():
    ev = r.enforce_tool_policy("documents.delete", "org1", {"source": "internal"})
    assert ev["decision"] == "allow_with_audit"
    assert _audit_rows and _audit_rows[0]["decision"] == "allow_with_audit"


def test_user_tier3_without_override_denied_and_audited():
    with pytest.raises(r.PolicyDenied):
        r.enforce_tool_policy(
            "documents.delete", "org1", {"source": "user", "user_id": "u", "permissions": []}
        )
    assert _audit_rows and _audit_rows[0]["result_status"] == "blocked"


# ---------------------------------------------------------------------------
# Fail closed on audit write failure (Tier-3 only)
# ---------------------------------------------------------------------------


def test_high_risk_blocked_when_audit_write_fails(monkeypatch):
    def _fail(table: str, row: dict):
        raise RuntimeError("supabase unavailable")

    monkeypatch.setattr(sys.modules["app.database"].SupabaseDB, "insert", _fail)
    with pytest.raises(r.PolicyDenied) as exc:
        r.enforce_tool_policy("documents.delete", "org1", {"source": "internal"})
    assert exc.value.evaluation["decision"] == "blocked"


def test_tier2_still_runs_when_audit_write_fails(monkeypatch):
    def _fail(table: str, row: dict):
        raise RuntimeError("supabase unavailable")

    monkeypatch.setattr(sys.modules["app.database"].SupabaseDB, "insert", _fail)
    ev = r.enforce_tool_policy("documents.reprocess", "org1", {"source": "internal"})
    assert ev["decision"] == "allow_with_audit"


def test_allow_records_audit_row():
    r.enforce_tool_policy("documents.reprocess", "org1", {"source": "internal"})
    assert len(_audit_rows) == 1
    assert _audit_rows[0]["tool_name"] == "documents.reprocess"
    assert _audit_rows[0]["organization_id"] == "org1"
    assert _audit_rows[0]["decision"] == "allow_with_audit"
