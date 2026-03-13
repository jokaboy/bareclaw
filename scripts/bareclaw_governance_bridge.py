#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _resolve_obsidian_mcp_root() -> Path:
    explicit = os.environ.get("BARECLAW_OBSIDIAN_MCP_ROOT")
    if explicit:
        return Path(explicit).expanduser().resolve(strict=False)

    continuity_bridge = os.environ.get("BARECLAW_CONTINUITY_BRIDGE")
    if continuity_bridge:
        return Path(continuity_bridge).expanduser().resolve(strict=False).parents[1]

    return (Path.home() / "Obsidian" / "tools" / "obsidian-mcp").resolve(strict=False)


ROOT = _resolve_obsidian_mcp_root()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from obsidian_mcp.server import DEFAULT_DATA_DIR, DEFAULT_VAULT_ROOT, ObsidianMCPService  # noqa: E402


def _emit(payload: dict) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0 if payload.get("ok") else 1


def _fail(message: str) -> int:
    return _emit({"ok": False, "error": message, "errors": [message]})


def _clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _call_tool(service: ObsidianMCPService, method_name: str, arguments: dict) -> dict:
    tool = getattr(service, method_name)
    result = tool(arguments)
    if not isinstance(result, dict) or not bool(result.get("ok")):
        errors = result.get("errors") if isinstance(result, dict) else None
        raise RuntimeError(f"{method_name} failed: {errors}")
    data = result.get("data")
    return data if isinstance(data, dict) else {}


def _ensure_writer_env() -> None:
    os.environ.setdefault("OBSIDIAN_MCP_VAULT", DEFAULT_VAULT_ROOT)
    os.environ.setdefault("OBSIDIAN_MCP_DATA_DIR", DEFAULT_DATA_DIR)
    os.environ["WRITE_DISABLED"] = "false"
    os.environ.setdefault("WRITE_ALLOWED_PREFIXES", "0 Agent Vault/Agents,1 Rough Notes,3 Tags")


def _write_artifact_draft(service: ObsidianMCPService, payload: dict) -> dict:
    workspace_id = _clean(payload.get("workspace_id"))
    project_id = _clean(payload.get("project_id"))
    run_id = _clean(payload.get("run_id"))
    title = _clean(payload.get("title"))
    body_markdown = _clean(payload.get("body_markdown"))
    doc_type = _clean(payload.get("doc_type")) or "project_plan"
    participants = payload.get("participants")
    if not workspace_id or not project_id or not run_id or not title or not body_markdown:
        raise RuntimeError("write-artifact-draft requires workspace_id, project_id, run_id, title, and body_markdown")
    if participants is not None and not isinstance(participants, list):
        raise RuntimeError("participants must be a list when provided")

    return _call_tool(
        service,
        "tool_agents_write_artifact_draft",
        {
            "workspace_id": workspace_id,
            "project_id": project_id,
            "run_id": run_id,
            "persona_id": "orchestrator",
            "title": title,
            "body_markdown": body_markdown,
            "doc_type": doc_type,
            "participants": participants,
        },
    )


def _queue_approval_request(service: ObsidianMCPService, payload: dict) -> dict:
    scope = _clean(payload.get("scope"))
    reason = _clean(payload.get("reason"))
    if not scope or not reason:
        raise RuntimeError("queue-approval-request requires scope and reason")
    return _call_tool(
        service,
        "tool_agents_queue_approval_request",
        {
            "scope": scope,
            "reason": reason,
            "requested_by": _clean(payload.get("requested_by")) or "orchestrator",
            "workspace_id": _clean(payload.get("workspace_id")),
            "project_id": _clean(payload.get("project_id")),
            "run_id": _clean(payload.get("run_id")),
        },
    )


def _list_approval_requests(service: ObsidianMCPService, payload: dict) -> dict:
    return _call_tool(
        service,
        "tool_agents_list_approval_requests",
        {
            "status": _clean(payload.get("status")),
            "workspace_id": _clean(payload.get("workspace_id")),
            "project_id": _clean(payload.get("project_id")),
            "limit": payload.get("limit"),
        },
    )


def _decide_approval_request(service: ObsidianMCPService, payload: dict) -> dict:
    request_id = _clean(payload.get("request_id"))
    decision = _clean(payload.get("decision"))
    if not request_id or not decision:
        raise RuntimeError("decide-approval-request requires request_id and decision")
    return _call_tool(
        service,
        "tool_agents_decide_approval_request",
        {
            "request_id": request_id,
            "decision": decision,
            "decided_by": _clean(payload.get("decided_by")) or "orchestrator",
            "decision_note": _clean(payload.get("decision_note")),
            "ttl_minutes": payload.get("ttl_minutes"),
        },
    )


def _read_intake_metadata(service: ObsidianMCPService, payload: dict) -> dict:
    project_path = _clean(payload.get("project_path"))
    if not project_path:
        raise RuntimeError("read-intake-metadata requires project_path")

    note_data: dict | None = None
    note_path = project_path

    if project_path.endswith(".md"):
        note_data = _call_tool(service, "tool_read_note", {"path": project_path})
    else:
        listing = _call_tool(service, "tool_list_notes", {"folder": project_path, "limit": 20})
        notes = listing.get("notes")
        if isinstance(notes, list) and notes:
            first = notes[0]
            if isinstance(first, dict) and isinstance(first.get("path"), str):
                note_path = first["path"]
                note_data = _call_tool(service, "tool_read_note", {"path": note_path})

    frontmatter = note_data.get("frontmatter") if isinstance(note_data, dict) else None
    metadata = frontmatter if isinstance(frontmatter, dict) else {}

    triage_required = metadata.get("triage_required")
    if not isinstance(triage_required, bool):
        triage_required = None

    return {
        "path": note_path,
        "triage_required": triage_required,
        "intake_stage": _clean(metadata.get("intake_stage")),
        "workspace_id": _clean(metadata.get("workspace_id")),
        "project_id": _clean(metadata.get("project_id")),
        "status": _clean(metadata.get("status")),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {
        "write-artifact-draft",
        "queue-approval-request",
        "list-approval-requests",
        "read-intake-metadata",
        "decide-approval-request",
    }:
        return _fail(
            "usage: bareclaw_governance_bridge.py "
            "<write-artifact-draft|queue-approval-request|list-approval-requests|read-intake-metadata|decide-approval-request>"
        )

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
    except Exception as exc:
        return _fail(f"invalid JSON payload: {exc}")

    try:
        _ensure_writer_env()
        service = ObsidianMCPService()
        if argv[1] == "write-artifact-draft":
            data = _write_artifact_draft(service, payload)
        elif argv[1] == "queue-approval-request":
            data = _queue_approval_request(service, payload)
        elif argv[1] == "list-approval-requests":
            data = _list_approval_requests(service, payload)
        elif argv[1] == "read-intake-metadata":
            data = _read_intake_metadata(service, payload)
        else:
            data = _decide_approval_request(service, payload)
        return _emit({"ok": True, "data": data})
    except Exception as exc:
        return _fail(str(exc))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
