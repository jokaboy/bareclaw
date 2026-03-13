#!/bin/bash
# Install the BAREclaw daemon service and/or heartbeat scheduler.
# macOS: launchd agents in ~/Library/LaunchAgents/
# Linux: systemd user units in ~/.config/systemd/user/
# Safe to call repeatedly — idempotent.

set -euo pipefail

HEARTBEAT_DIR="$(cd "$(dirname "$0")" && pwd)"
BARECLAW_DIR="$(cd "$HEARTBEAT_DIR/.." && pwd)"
HEARTBEAT_SCRIPT="$HEARTBEAT_DIR/heartbeat.sh"
LAUNCHD_STAGE_DIR="$HOME/Library/Application Support/BAREclaw/heartbeat"
HEARTBEAT_SCRIPT_FOR_LAUNCHD="$HEARTBEAT_SCRIPT"
SECURITY_SCAN_SCRIPT_FOR_LAUNCHD="$HEARTBEAT_DIR/security-scan.sh"
KNOWLEDGE_SCAN_SCRIPT_FOR_LAUNCHD="$HEARTBEAT_DIR/knowledge-scan.sh"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
APP_ENTRY="$BARECLAW_DIR/dist/index.js"
ENV_FILE="$BARECLAW_DIR/.env"
BARECLAW_HTTP_TOKEN_VALUE=""
BARECLAW_HEARTBEAT_NOTIFY_CHANNEL_VALUE=""
LAUNCHD_WORKDIR="$LAUNCHD_STAGE_DIR"
OS="$(uname -s)"
INSTALL_DAEMON=1
INSTALL_HEARTBEAT=1
INSTALL_SECURITY_SCAN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --daemon-only)
      INSTALL_DAEMON=1
      INSTALL_HEARTBEAT=0
      INSTALL_SECURITY_SCAN=0
      ;;
    --heartbeat-only)
      INSTALL_DAEMON=0
      INSTALL_HEARTBEAT=1
      INSTALL_SECURITY_SCAN=0
      ;;
    --security-scan-only)
      INSTALL_DAEMON=0
      INSTALL_HEARTBEAT=0
      INSTALL_SECURITY_SCAN=1
      ;;
    *)
      echo "Error: unknown flag '$1'. Supported: --daemon-only, --heartbeat-only, --security-scan-only"
      exit 1
      ;;
  esac
  shift
done

if [ ! -f "$HEARTBEAT_SCRIPT" ]; then
  echo "Error: $HEARTBEAT_SCRIPT not found"
  exit 1
fi
if [ -z "$NODE_BIN" ]; then
  echo "Error: node binary not found in PATH"
  exit 1
fi
if [ "$INSTALL_DAEMON" -eq 1 ] && [ ! -f "$APP_ENTRY" ]; then
  echo "Error: $APP_ENTRY not found. Run 'npm run build' first."
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  BARECLAW_HTTP_TOKEN_VALUE=$(grep -E '^BARECLAW_HTTP_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
  BARECLAW_HEARTBEAT_NOTIFY_CHANNEL_VALUE=$(grep -E '^BARECLAW_HEARTBEAT_NOTIFY_CHANNEL=' "$ENV_FILE" | cut -d= -f2- || true)
  if [ -z "$BARECLAW_HEARTBEAT_NOTIFY_CHANNEL_VALUE" ]; then
    first_allowed_user=$(grep -E '^BARECLAW_ALLOWED_USERS=' "$ENV_FILE" | cut -d= -f2- | tr ',' '\n' | sed -n '1s/^[[:space:]]*//;1s/[[:space:]]*$//;1p' || true)
    if [ -n "$first_allowed_user" ]; then
      BARECLAW_HEARTBEAT_NOTIFY_CHANNEL_VALUE="tg-$first_allowed_user"
    fi
  fi
fi

chmod +x "$HEARTBEAT_SCRIPT"
chmod +x "$HEARTBEAT_DIR/security-scan.sh" 2>/dev/null || true
chmod +x "$HEARTBEAT_DIR/knowledge-scan.sh" 2>/dev/null || true

stage_launchd_scripts() {
  HEARTBEAT_SCRIPT_FOR_LAUNCHD="$LAUNCHD_STAGE_DIR/heartbeat.sh"
  SECURITY_SCAN_SCRIPT_FOR_LAUNCHD="$LAUNCHD_STAGE_DIR/security-scan.sh"
  KNOWLEDGE_SCAN_SCRIPT_FOR_LAUNCHD="$LAUNCHD_STAGE_DIR/knowledge-scan.sh"

  mkdir -p "$LAUNCHD_STAGE_DIR"
  cp "$HEARTBEAT_DIR/heartbeat.sh" "$HEARTBEAT_SCRIPT_FOR_LAUNCHD"
  cp "$HEARTBEAT_DIR/security-scan.sh" "$SECURITY_SCAN_SCRIPT_FOR_LAUNCHD" 2>/dev/null || true
  cp "$HEARTBEAT_DIR/knowledge-scan.sh" "$KNOWLEDGE_SCAN_SCRIPT_FOR_LAUNCHD" 2>/dev/null || true
  chmod +x "$HEARTBEAT_SCRIPT_FOR_LAUNCHD" "$SECURITY_SCAN_SCRIPT_FOR_LAUNCHD" "$KNOWLEDGE_SCAN_SCRIPT_FOR_LAUNCHD" 2>/dev/null || true
}

template_file() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|__HEARTBEAT_SCRIPT__|$HEARTBEAT_SCRIPT_FOR_LAUNCHD|g" \
    -e "s|__SECURITY_SCAN_SCRIPT__|$SECURITY_SCAN_SCRIPT_FOR_LAUNCHD|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__BARECLAW_DIR__|$BARECLAW_DIR|g" \
    -e "s|__BARECLAW_HTTP_TOKEN__|$BARECLAW_HTTP_TOKEN_VALUE|g" \
    -e "s|__BARECLAW_HEARTBEAT_NOTIFY_CHANNEL__|$BARECLAW_HEARTBEAT_NOTIFY_CHANNEL_VALUE|g" \
    -e "s|__LAUNCHD_WORKDIR__|$LAUNCHD_WORKDIR|g" \
    -e "s|__APP_ENTRY__|$APP_ENTRY|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    "$src" > "$dst"
}

install_macos() {
  local domain="gui/$(id -u)"
  local launch_agents_dir="$HOME/Library/LaunchAgents"
  local daemon_template="$HEARTBEAT_DIR/com.bareclaw.daemon.plist"
  local heartbeat_template="$HEARTBEAT_DIR/com.bareclaw.heartbeat.plist"
  local daemon_dst="$launch_agents_dir/com.bareclaw.daemon.plist"
  local heartbeat_dst="$launch_agents_dir/com.bareclaw.heartbeat.plist"

  mkdir -p "$launch_agents_dir"
  stage_launchd_scripts

  if [ "$INSTALL_DAEMON" -eq 1 ]; then
    if [ ! -f "$daemon_template" ]; then
      echo "Error: $daemon_template not found"
      exit 1
    fi
    launchctl bootout "$domain" "$daemon_dst" 2>/dev/null || launchctl unload "$daemon_dst" 2>/dev/null || true
    template_file "$daemon_template" "$daemon_dst"
    launchctl bootstrap "$domain" "$daemon_dst" 2>/dev/null || launchctl load "$daemon_dst"
    echo "[daemon] Installed (launchd)."
    echo "[daemon] Status: launchctl print $domain/com.bareclaw.daemon"
  fi

  if [ "$INSTALL_HEARTBEAT" -eq 1 ]; then
    if [ ! -f "$heartbeat_template" ]; then
      echo "Error: $heartbeat_template not found"
      exit 1
    fi
    launchctl bootout "$domain" "$heartbeat_dst" 2>/dev/null || launchctl unload "$heartbeat_dst" 2>/dev/null || true
    template_file "$heartbeat_template" "$heartbeat_dst"
    launchctl bootstrap "$domain" "$heartbeat_dst" 2>/dev/null || launchctl load "$heartbeat_dst"
    echo "[heartbeat] Installed (launchd). Fires every hour."
    echo "[heartbeat] Status: launchctl print $domain/com.bareclaw.heartbeat"
  fi

  if [ "$INSTALL_SECURITY_SCAN" -eq 1 ]; then
    local security_scan_template="$HEARTBEAT_DIR/com.bareclaw.security-scan.plist"
    local security_scan_dst="$launch_agents_dir/com.bareclaw.security-scan.plist"
    if [ ! -f "$security_scan_template" ]; then
      echo "Error: $security_scan_template not found"
      exit 1
    fi
    launchctl bootout "$domain" "$security_scan_dst" 2>/dev/null || launchctl unload "$security_scan_dst" 2>/dev/null || true
    template_file "$security_scan_template" "$security_scan_dst"
    launchctl bootstrap "$domain" "$security_scan_dst" 2>/dev/null || launchctl load "$security_scan_dst"
    echo "[security-scan] Installed (launchd). Fires daily at 6am."
    echo "[security-scan] Status: launchctl print $domain/com.bareclaw.security-scan"
  fi
}

install_linux() {
  local systemd_dir="$HOME/.config/systemd/user"
  local daemon_template="$HEARTBEAT_DIR/bareclaw.service"
  local heartbeat_service_template="$HEARTBEAT_DIR/bareclaw-heartbeat.service"
  local heartbeat_timer_template="$HEARTBEAT_DIR/bareclaw-heartbeat.timer"

  mkdir -p "$systemd_dir"

  if [ "$INSTALL_DAEMON" -eq 1 ]; then
    if [ ! -f "$daemon_template" ]; then
      echo "Error: $daemon_template not found"
      exit 1
    fi
    template_file "$daemon_template" "$systemd_dir/bareclaw.service"
  fi

  if [ "$INSTALL_HEARTBEAT" -eq 1 ]; then
    if [ ! -f "$heartbeat_service_template" ] || [ ! -f "$heartbeat_timer_template" ]; then
      echo "Error: heartbeat unit files not found in $HEARTBEAT_DIR"
      exit 1
    fi
    template_file "$heartbeat_service_template" "$systemd_dir/bareclaw-heartbeat.service"
    cp "$heartbeat_timer_template" "$systemd_dir/bareclaw-heartbeat.timer"
  fi

  systemctl --user daemon-reload

  if [ "$INSTALL_DAEMON" -eq 1 ]; then
    systemctl --user enable --now bareclaw.service
    echo "[daemon] Installed (systemd user service)."
    echo "[daemon] Status: systemctl --user status bareclaw.service"
  fi

  if [ "$INSTALL_HEARTBEAT" -eq 1 ]; then
    systemctl --user enable --now bareclaw-heartbeat.timer
    echo "[heartbeat] Installed (systemd user timer). Fires every hour."
    echo "[heartbeat] Status: systemctl --user status bareclaw-heartbeat.timer"
  fi

  if [ "$INSTALL_SECURITY_SCAN" -eq 1 ]; then
    echo "[security-scan] SKIP: systemd unit files not yet available. macOS only for now."
  fi
}

case "$OS" in
  Darwin)
    install_macos
    ;;
  Linux)
    install_linux
    ;;
  *)
    echo "Error: unsupported platform '$OS'. Only macOS (launchd) and Linux (systemd) are supported."
    exit 1
    ;;
esac

if [ "$INSTALL_DAEMON" -eq 1 ]; then
  echo "[daemon] Logs: /tmp/bareclaw-daemon.log"
fi
if [ "$INSTALL_HEARTBEAT" -eq 1 ]; then
  echo "[heartbeat] Logs: /tmp/bareclaw-heartbeat.log"
  echo "[knowledge-scan] Logs: /tmp/bareclaw-knowledge-scan.log"
fi
if [ "$INSTALL_SECURITY_SCAN" -eq 1 ]; then
  echo "[security-scan] Logs: /tmp/bareclaw-security-scan-stdout.log, /tmp/bareclaw-security-scan-stderr.log"
fi
