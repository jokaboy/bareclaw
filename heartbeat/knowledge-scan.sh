#!/bin/bash
# BAREclaw knowledge assurance scan.
# Runs lightweight web-memory checks and reports urgent findings through BAREclaw.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BARECLAW_DIR="${BARECLAW_DIR_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BARECLAW_PORT="${BARECLAW_PORT:-3000}"
BARECLAW_URL="http://localhost:$BARECLAW_PORT"
LOG="/tmp/bareclaw-knowledge-scan.log"

OBSIDIAN_MCP_DIR="${OBSIDIAN_MCP_DIR:-/Users/ciaran/Obsidian/tools/obsidian-mcp}"
WEB_MEMORY_DB="${WEB_MEMORY_DB:-$HOME/.codex/web-memory/web_memory.db}"
KNOWLEDGE_SCAN_SCRIPT="${KNOWLEDGE_SCAN_SCRIPT:-$OBSIDIAN_MCP_DIR/scripts/web_memory_assurance.py}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

BARECLAW_HTTP_TOKEN="${BARECLAW_HTTP_TOKEN:-}"
if [ -z "$BARECLAW_HTTP_TOKEN" ] && [ -f "$BARECLAW_DIR/.env" ]; then
  BARECLAW_HTTP_TOKEN=$(grep -E '^BARECLAW_HTTP_TOKEN=' "$BARECLAW_DIR/.env" | cut -d= -f2- || true)
fi

AUTH_ARGS=()
if [ -n "$BARECLAW_HTTP_TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $BARECLAW_HTTP_TOKEN")
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

report_findings() {
  local message="$1"

  if curl -fsS --max-time 30 -X POST "$BARECLAW_URL/message" \
    -H 'Content-Type: application/json' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    -d "$(jq -n --arg text "$message" --arg channel "knowledge-scan" '{text: $text, channel: $channel}')" \
    >/dev/null 2>&1; then
    log "Reported urgent knowledge findings"
  else
    log "WARN: Failed to report knowledge findings to BAREclaw"
  fi
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  log "SKIP: python binary $PYTHON_BIN not found"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "SKIP: jq not installed"
  exit 0
fi

if [ ! -f "$KNOWLEDGE_SCAN_SCRIPT" ]; then
  log "SKIP: knowledge scan script not found at $KNOWLEDGE_SCAN_SCRIPT"
  exit 0
fi

log "Running knowledge scan against $WEB_MEMORY_DB"
scan_json="$($PYTHON_BIN "$KNOWLEDGE_SCAN_SCRIPT" --db-path "$WEB_MEMORY_DB" --mode lightweight --persist --json 2>>"$LOG" || true)"

if [ -z "$scan_json" ]; then
  log "WARN: knowledge scan produced no output"
  exit 0
fi

urgent_count=$(printf '%s' "$scan_json" | jq -r '.summary.open_urgent_total // 0' 2>/dev/null || echo "0")
open_total=$(printf '%s' "$scan_json" | jq -r '.summary.open_total // 0' 2>/dev/null || echo "0")

if [ "$urgent_count" -eq 0 ] 2>/dev/null; then
  log "Knowledge scan clean for urgent issues (open_total=$open_total)"
  exit 0
fi

findings=$(printf '%s' "$scan_json" | jq -r '
  .findings[]
  | select((.status // "open") == "open" and (.urgent // false) == true)
  | "- [" + ((.severity // "unknown") | ascii_upcase) + "] " + (.code // "unknown") + ": " + (.detail // "")
' 2>/dev/null || true)

if [ -z "$findings" ]; then
  findings="- Urgent findings were detected, but detail rendering failed."
fi

message=$(printf 'Knowledge scan found %s urgent web-memory issue(s) (open_total=%s).\n%s\nReview the daily web-memory pipeline and deferred capture backlog.' "$urgent_count" "$open_total" "$findings")
report_findings "$message"

log "Knowledge scan completed with urgent findings"
