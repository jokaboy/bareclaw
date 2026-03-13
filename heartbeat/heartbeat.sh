#!/bin/bash
# BAREclaw heartbeat runner.
# Called by launchd on a schedule. Ensures the server is running,
# then sends a heartbeat message to the "heartbeat" channel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BARECLAW_DIR="${BARECLAW_DIR_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BARECLAW_PORT="${BARECLAW_PORT:-3000}"
BARECLAW_URL="http://localhost:$BARECLAW_PORT"
LOG="/tmp/bareclaw-heartbeat.log"
OS="$(uname -s)"
HEARTBEAT_NOTIFY_CHANNEL="${BARECLAW_HEARTBEAT_NOTIFY_CHANNEL:-}"

# Load token from environment first, then fall back to .env if available.
BARECLAW_HTTP_TOKEN="${BARECLAW_HTTP_TOKEN:-}"
if [ -z "$BARECLAW_HTTP_TOKEN" ] && [ -f "$BARECLAW_DIR/.env" ]; then
  BARECLAW_HTTP_TOKEN=$(grep -E '^BARECLAW_HTTP_TOKEN=' "$BARECLAW_DIR/.env" | cut -d= -f2- || true)
fi
if [ -z "$HEARTBEAT_NOTIFY_CHANNEL" ] && [ -f "$BARECLAW_DIR/.env" ]; then
  HEARTBEAT_NOTIFY_CHANNEL=$(grep -E '^BARECLAW_HEARTBEAT_NOTIFY_CHANNEL=' "$BARECLAW_DIR/.env" | cut -d= -f2- || true)
fi
if [ -z "$HEARTBEAT_NOTIFY_CHANNEL" ] && [ -f "$BARECLAW_DIR/.env" ]; then
  first_allowed_user=$(grep -E '^BARECLAW_ALLOWED_USERS=' "$BARECLAW_DIR/.env" | cut -d= -f2- | tr ',' '\n' | sed -n '1s/^[[:space:]]*//;1s/[[:space:]]*$//;1p' || true)
  if [ -n "$first_allowed_user" ]; then
    HEARTBEAT_NOTIFY_CHANNEL="tg-$first_allowed_user"
  fi
fi

# Build auth args for curl
AUTH_ARGS=()
if [ -n "$BARECLAW_HTTP_TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $BARECLAW_HTTP_TOKEN")
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

send_attention_notification() {
  local message="$1"

  if [ -z "$HEARTBEAT_NOTIFY_CHANNEL" ]; then
    log "Heartbeat attention detected, but no notification channel is configured"
    return 0
  fi

  if curl -fsS --max-time 30 -X POST "$BARECLAW_URL/send" \
    -H 'Content-Type: application/json' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    -d "$(jq -n --arg channel "$HEARTBEAT_NOTIFY_CHANNEL" --arg text "$message" '{channel: $channel, text: $text}')" \
    >/dev/null 2>&1; then
    log "Heartbeat attention forwarded to $HEARTBEAT_NOTIFY_CHANNEL"
  else
    log "WARN: Failed to forward heartbeat attention to $HEARTBEAT_NOTIFY_CHANNEL"
  fi
}

# Check if server is responding over HTTP
server_alive() {
  curl -fsS --max-time 5 "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" "$BARECLAW_URL/healthz" >/dev/null 2>&1
}

start_managed_daemon() {
  case "$OS" in
    Darwin)
      local domain="gui/$(id -u)"
      local label="com.bareclaw.daemon"
      local plist="$HOME/Library/LaunchAgents/${label}.plist"
      if [ ! -f "$plist" ]; then
        log "ERROR: daemon plist not found at $plist"
        return 1
      fi
      if launchctl print "$domain/$label" >/dev/null 2>&1; then
        launchctl kickstart -k "$domain/$label" >> "$LOG" 2>&1 || launchctl kickstart "$domain/$label" >> "$LOG" 2>&1
      else
        launchctl bootstrap "$domain" "$plist" >> "$LOG" 2>&1 || launchctl load "$plist" >> "$LOG" 2>&1
      fi
      ;;
    Linux)
      systemctl --user restart bareclaw.service >> "$LOG" 2>&1 || systemctl --user start bareclaw.service >> "$LOG" 2>&1
      ;;
    *)
      log "ERROR: unsupported platform '$OS'"
      return 1
      ;;
  esac
}

# Start the server if it's not running
if ! server_alive; then
  log "Server not responding, starting managed BAREclaw daemon..."
  if ! start_managed_daemon; then
    log "ERROR: Failed to start managed daemon"
    exit 1
  fi
  log "Managed daemon start requested, waiting for it to come up..."

  # Wait up to 60s for the server to start
  for i in $(seq 1 60); do
    if server_alive; then
      log "Server is up after ${i}s"
      break
    fi
    sleep 1
  done

  if ! server_alive; then
    log "ERROR: Server failed to start after 60s"
    exit 1
  fi
fi

# Send heartbeat
log "Sending heartbeat..."
if RESPONSE=$(curl -sf --max-time 300 -X POST "$BARECLAW_URL/message" \
  -H 'Content-Type: application/json' \
  "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
  -d "$(jq -n \
    --arg text "Heartbeat. Review pending tasks, reminders, and scheduled work. Stay in read-only triage mode. Reply with exactly one line that starts with OK: if nothing needs attention, or ATTENTION: if the user should be nudged." \
    --arg channel "heartbeat" \
    '{text: $text, channel: $channel}')" 2>&1); then
  if command -v jq >/dev/null 2>&1; then
    assistant_text=$(printf '%s' "$RESPONSE" | jq -r '.text // ""' 2>/dev/null || echo "")
    if [ -n "$assistant_text" ]; then
      log "Heartbeat response: $(printf '%s' "$assistant_text" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    fi
    if [[ "$assistant_text" == ATTENTION:* ]]; then
      attention_message="${assistant_text#ATTENTION: }"
      if [ -z "$attention_message" ]; then
        attention_message="Heartbeat detected something that needs your attention."
      fi
      send_attention_notification "$attention_message"
    fi
  fi
  log "Heartbeat OK"
else
  log "Heartbeat failed: $RESPONSE"
fi

# Run hourly security scan (non-blocking — findings reported via BAREclaw)
SECURITY_SCAN="$SCRIPT_DIR/security-scan.sh"
if [ -x "$SECURITY_SCAN" ]; then
  log "Running hourly security scan..."
  "$SECURITY_SCAN" hourly >> "$LOG" 2>&1 || log "Security scan completed with warnings"
fi

KNOWLEDGE_SCAN="$SCRIPT_DIR/knowledge-scan.sh"
if [ -x "$KNOWLEDGE_SCAN" ]; then
  log "Running hourly knowledge scan..."
  "$KNOWLEDGE_SCAN" >> "$LOG" 2>&1 || log "Knowledge scan completed with warnings"
fi
