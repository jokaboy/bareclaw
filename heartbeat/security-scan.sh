#!/bin/bash
# BAREclaw security scan runner.
# Called by heartbeat or launchd on a schedule.
# Runs V0 security checks across all registered repos and reports
# findings through BAREclaw's HTTP API (which writes to the vault
# via the governance bridge).
#
# Hourly checks: secret patterns, gitignore drift, env exposure
# Daily checks: dependency audit, full cross-repo scan, render.yaml audit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BARECLAW_DIR="${BARECLAW_DIR_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MISC_PROJECTS_DIR="$(cd "$BARECLAW_DIR/.." && pwd)"
BARECLAW_PORT="${BARECLAW_PORT:-3000}"
BARECLAW_URL="http://localhost:$BARECLAW_PORT"
LOG="/tmp/bareclaw-security-scan.log"

# Load token from environment first, then fall back to .env if available.
BARECLAW_HTTP_TOKEN="${BARECLAW_HTTP_TOKEN:-}"
if [ -z "$BARECLAW_HTTP_TOKEN" ] && [ -f "$BARECLAW_DIR/.env" ]; then
  BARECLAW_HTTP_TOKEN=$(grep -E '^BARECLAW_HTTP_TOKEN=' "$BARECLAW_DIR/.env" | cut -d= -f2- || true)
fi

AUTH_ARGS=()
if [ -n "$BARECLAW_HTTP_TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $BARECLAW_HTTP_TOKEN")
fi

resolve_repo_path() {
  local env_override="$1"
  shift

  if [ -n "$env_override" ] && [ -d "$env_override/.git" ]; then
    printf '%s\n' "$env_override"
    return 0
  fi

  local candidate
  for candidate in "$@"; do
    if [ -d "$candidate/.git" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

# Registered repos to scan.
# Prefer explicit overrides, then the current workspace checkout names, then
# legacy paths for backward compatibility during migration.
REPOS=()
if repo=$(resolve_repo_path "${BARECLAW_REPO_EASY_LISTENING:-}" \
  "$MISC_PROJECTS_DIR/easy-listening" \
  "$MISC_PROJECTS_DIR/Easy-Listening"); then
  REPOS+=("$repo")
fi
if repo=$(resolve_repo_path "${BARECLAW_REPO_ADUBONIZER:-}" \
  "$MISC_PROJECTS_DIR/adubonizer" \
  "$MISC_PROJECTS_DIR/260213 Adubonizer"); then
  REPOS+=("$repo")
fi
if repo=$(resolve_repo_path "${BARECLAW_REPO_BARECLAW:-}" \
  "$MISC_PROJECTS_DIR/bareclaw"); then
  REPOS+=("$repo")
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

read_tracked_file_content() {
  local repo="$1"
  local path="$2"

  if git -C "$repo" cat-file -e "HEAD:$path" >/dev/null 2>&1; then
    git -C "$repo" show "HEAD:$path" 2>/dev/null
    return 0
  fi

  return 1
}

read_gitignore_content() {
  local repo="$1"
  local repo_name
  repo_name=$(basename "$repo")

  if read_tracked_file_content "$repo" ".gitignore"; then
    return 0
  fi

  log "WARN: $repo_name — .gitignore is not readable from git metadata; skipping env ignore check"
  return 1
}

read_render_yaml_content() {
  local repo="$1"
  local repo_name
  repo_name=$(basename "$repo")

  if read_tracked_file_content "$repo" "render.yaml"; then
    return 0
  fi

  log "WARN: $repo_name — render.yaml is not readable from git metadata; skipping render.yaml audit"
  return 1
}

# Report a finding to BAREclaw for vault recording
report_finding() {
  local severity="$1"
  local system="$2"
  local finding="$3"
  local detail="$4"

  local message="Security scan finding [$severity] in $system: $finding. $detail. Record this as a security incident in the vault using agents_record_incident with security_failure_mode."

  if curl -fsS --max-time 30 -X POST "$BARECLAW_URL/message" \
    -H 'Content-Type: application/json' \
    "${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}" \
    -d "$(jq -n --arg text "$message" --arg channel "security-scan" '{text: $text, channel: $channel}')" \
    >/dev/null 2>&1; then
    log "Reported: [$severity] $system — $finding"
  else
    log "WARN: Failed to report finding to BAREclaw"
  fi
}

# ---------------------------------------------------------------------------
# Hourly checks
# ---------------------------------------------------------------------------

check_env_files_not_tracked() {
  log "Running: env file tracking check"
  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    if [ ! -d "$repo/.git" ]; then
      continue
    fi

    # Check if any .env files are tracked
    tracked_env=$(cd "$repo" && git ls-files '*.env' '.env' '.env.*' 2>/dev/null || true)
    if [ -n "$tracked_env" ]; then
      report_finding "critical" "$repo_name" "secret_exposure" \
        ".env file tracked in git: $tracked_env"
    fi
  done
}

check_gitignore_env() {
  log "Running: gitignore env check"
  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    local gitignore_content=""
    if gitignore_content=$(read_gitignore_content "$repo"); then
      :
    else
      continue
    fi

    if ! printf '%s\n' "$gitignore_content" | grep -q '\.env'; then
      report_finding "high" "$repo_name" "secret_exposure" \
        ".gitignore does not exclude .env files"
    fi
  done
}

check_secret_patterns() {
  log "Running: secret pattern scan"
  local patterns=(
    'sk-[a-zA-Z0-9]{20,}'
    '[0-9]{8,}:[A-Za-z0-9_-]{30,}'
  )

  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    if [ ! -d "$repo/.git" ]; then
      continue
    fi

    for pattern in "${patterns[@]}"; do
      local matches
      matches=$(cd "$repo" && git grep -l -E "$pattern" -- \
        ':!*.example' ':!*.test.*' ':!*test_*' ':!*.sh' ':!*.md' \
        2>/dev/null || true)

      if [ -n "$matches" ]; then
        report_finding "critical" "$repo_name" "secret_exposure" \
          "Secret pattern match in tracked files: $matches"
      fi
    done
  done
}

# ---------------------------------------------------------------------------
# Daily checks
# ---------------------------------------------------------------------------

check_npm_audit() {
  log "Running: npm audit"
  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    if [ ! -f "$repo/package.json" ]; then
      continue
    fi

    local audit_output
    audit_output=$(cd "$repo" && npm audit --audit-level=moderate --json 2>/dev/null || true)
    local vuln_count
    vuln_count=$(echo "$audit_output" | jq '.metadata.vulnerabilities.moderate + .metadata.vulnerabilities.high + .metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")

    if [ "$vuln_count" -gt 0 ] 2>/dev/null; then
      report_finding "medium" "$repo_name" "dependency_vulnerability" \
        "npm audit found $vuln_count moderate+ vulnerabilities"
    else
      log "  PASS: $repo_name — no npm vulnerabilities"
    fi
  done
}

check_pip_audit() {
  log "Running: pip-audit"
  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    if [ ! -f "$repo/requirements.txt" ] && [ ! -f "$repo/pyproject.toml" ]; then
      continue
    fi

    if command -v pip-audit >/dev/null 2>&1; then
      local audit_output
      audit_output=$(cd "$repo" && pip-audit --format json 2>/dev/null || true)
      local vuln_count
      vuln_count=$(echo "$audit_output" | jq 'length // 0' 2>/dev/null || echo "0")

      if [ "$vuln_count" -gt 0 ] 2>/dev/null; then
        report_finding "medium" "$repo_name" "dependency_vulnerability" \
          "pip-audit found $vuln_count vulnerabilities"
      else
        log "  PASS: $repo_name — no pip vulnerabilities"
      fi
    else
      log "  SKIP: pip-audit not installed"
    fi
  done
}

check_render_yaml() {
  log "Running: render.yaml audit"
  for repo in "${REPOS[@]}"; do
    local repo_name
    repo_name=$(basename "$repo")
    local render_yaml_content=""
    if ! render_yaml_content=$(read_render_yaml_content "$repo"); then
      continue
    fi

    if printf '%s\n' "$render_yaml_content" | grep -q '0\.0\.0\.0/0'; then
      report_finding "medium" "$repo_name" "authorization_boundary_violation" \
        "render.yaml contains 0.0.0.0/0 in ipAllowList — overly permissive network access"
    fi
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

SCAN_TYPE="${1:-hourly}"

log "=== Security scan started (type: $SCAN_TYPE) ==="

# Always run hourly checks
check_env_files_not_tracked
check_gitignore_env
check_secret_patterns

# Run daily checks only when requested
if [ "$SCAN_TYPE" = "daily" ]; then
  check_npm_audit
  check_pip_audit
  check_render_yaml
fi

log "=== Security scan completed ==="
