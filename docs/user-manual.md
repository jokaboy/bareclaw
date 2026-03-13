# BAREclaw User Manual

> One daemon, many mouths, one brain.

BAREclaw is a persistent daemon that multiplexes messages from multiple input channels (HTTP, Telegram, etc.) into persistent Claude Code sessions. Every channel gets its own isolated session with full context, tools, skills, MCP servers, and project access. Responses come back through the same channel they arrived on.

**Key design choice:** BAREclaw shells out to `claude -p` (the Claude Code CLI in persistent mode) rather than using the Agent SDK. CLI calls route through the Claude Max subscription (flat-rate unlimited). The Agent SDK bills per API token. For personal use with dozens of daily prompts, marginal API cost is $0.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Channels](#channels)
- [Concurrency Model](#concurrency-model)
- [HTTP Adapter](#http-adapter)
- [Telegram Adapter](#telegram-adapter)
- [Thread Commands](#thread-commands)
- [Capability Modes](#capability-modes)
- [Providers](#providers)
- [Heartbeat and Supervised Mode](#heartbeat-and-supervised-mode)
- [Self-Restart](#self-restart)
- [Authentication](#authentication)
- [Build and Scripts](#build-and-scripts)
- [Troubleshooting](#troubleshooting)
- [Writing a New Adapter](#writing-a-new-adapter)

---

## Quick Start

```bash
cd ~/dev/tools/bareclaw
npm install
cp .env.example .env   # edit if needed — works with zero config for localhost
npm run dev             # runs via tsx with .env file watching
```

Send it a message:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "hello"}'
```

First message per channel is slow (~15-30s, spawning `claude`). Subsequent messages reuse the warm process (3-5s).

---

## Architecture

```
[HTTP / Telegram / SMS / Shortcut / ...]
    → adapter (translates channel protocol → internal API)
        → ProcessManager.send(channel, content, context?)
            → session host (detached process per channel)
                → persistent claude process
        ← { text, duration_ms, coalesced? }
    ← response via same channel
```

**ProcessManager** — Manages all channels, spawns/connects session hosts, enforces strict FIFO queuing per channel, handles auto-reconnect.

**Session hosts** — Detached processes holding a single Claude session. Communicate via Unix domain sockets, survive server hot reloads.

**Adapters** — Thin translation layers: derive a channel key, build a ChannelContext, call `processManager.send()`, format the response.

---

## Configuration

All configuration via environment variables. Everything has sensible defaults — BAREclaw works with zero config for localhost.

| Variable | Default | Description |
|----------|---------|-------------|
| `BARECLAW_PORT` | `3000` | HTTP server port |
| `BARECLAW_CWD` | `$HOME` | Working directory for `claude` processes |
| `BARECLAW_MAX_TURNS` | `25` | Max agentic turns per message |
| `BARECLAW_ALLOWED_TOOLS` | `Read,Glob,Grep,Bash,Write,Edit,Skill,Task` | Tools auto-approved without confirmation |
| `BARECLAW_TIMEOUT_MS` | `0` | Per-message timeout in ms. **Must be 0** — non-zero kills the socket mid-response |
| `BARECLAW_STALLED_TURN_IDLE_MS` | `900000` | Silence threshold (ms) before auto-interrupt. `0` to disable |
| `BARECLAW_STALLED_TURN_INTERRUPT_GRACE_MS` | `30000` | Grace period after auto-interrupt before reset |
| `BARECLAW_STALLED_TURN_POLL_MS` | `15000` | Poll interval for stalled-turn checks |
| `BARECLAW_HTTP_TOKEN` | *(none)* | Bearer token for HTTP auth. Required for all HTTP endpoints except `/healthz` |
| `BARECLAW_TELEGRAM_TOKEN` | *(none)* | Telegram bot token from @BotFather |
| `BARECLAW_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs. **Required when Telegram is enabled** |
| `BARECLAW_HEARTBEAT_NOTIFY_CHANNEL` | *(auto)* | Optional explicit push target for `ATTENTION:` heartbeat responses |
| `BARECLAW_SESSION_FILE` | `.bareclaw-sessions.json` | Raw provider session map |
| `BARECLAW_CHANNEL_STATE_FILE` | `.bareclaw-channel-state.json` | Per-thread runtime state |
| `BARECLAW_CONTINUITY_BRIDGE` | *(none)* | Path to obsidian-mcp bridge for canonical continuity sync |
| `BARECLAW_CONTINUITY_PYTHON` | `python3` | Python binary for the continuity bridge |
| `BARECLAW_BOOTSTRAP_PROMPT` | *(none)* | Path to file appended to every new session's system prompt |
| `BARECLAW_PROVIDER` | `claude` | Default provider: `claude`, `codex`, `ollama`, or `opencode` |
| `BARECLAW_SUPERVISED` | *(none)* | Set to `1` for launchd/systemd. Restart exits cleanly instead of re-exec |
| `BARECLAW_WARM_CHANNELS` | *(none)* | Comma-separated channel IDs to pre-connect on startup |
| `BARECLAW_WARMUP_DELAY_MS` | `5000` | Delay before warm-up begins |

### Setting `BARECLAW_CWD`

Controls the project context for all `claude` processes:

- `~/dev/myproject` — Claude sees that project's `CLAUDE.md`, can read/edit its files, runs tools in that directory
- `~` — Claude sees your global `~/.claude/CLAUDE.md` and can access anything in your home directory
- Set to BAREclaw's own directory for self-modification

### Shared skill library

BAREClaw does not load skills from a private workspace directory. It launches
provider CLIs and inherits the skill roots those CLIs already use.

- `codex` -> `~/.codex/skills`
- `claude` -> `~/.claude/skills`
- `opencode` -> `~/.config/opencode/opencode.json` and the shared skill roots that config points at

On this machine those roots are expected to converge on the same shared skill
library, with `~/.codex/skills` as the canonical source of truth.

---

## Channels

A **channel** is the fundamental unit of session identity. Each unique channel string maps to exactly one persistent Claude process, one FIFO message queue, and one resumable session ID.

### Properties

- **Adapter-agnostic.** The channel key is an opaque string. Two adapters using the same channel key talk to the same Claude session.
- **One queue per channel.** Messages to different channels are fully concurrent. Messages to the same channel are serialized.
- **Persistent across restarts.** Session IDs are saved keyed by channel.

### Built-in Channel Keys

| Adapter | Pattern | Example |
|---------|---------|---------|
| HTTP | Caller-controlled via `channel` field | `http`, `http-work`, `http-123` |
| Telegram | `tg-<chatId>` or `tg-<chatId>-<threadId>` | `tg-123456789`, `tg-123456789-42` |

Telegram supergroups with **Topics** enabled give you multiple independent Claude sessions in one group. Each topic gets its own channel.

---

## Concurrency Model

### Different Channels → Fully Concurrent

Each channel has its own session host process, socket, and queue.

### Same Channel → Strict FIFO

Within a single channel, messages process one at a time, in arrival order:

1. First message arrives → dispatch immediately, set `busy = true`
2. Second message arrives → push to queue
3. First completes → `drainQueue()` shifts next message and dispatches
4. Repeat until queue empty

### Coalescing

When multiple messages queue while a channel is busy, `drainQueue()` **coalesces** them — text is joined with double newlines and dispatched as one turn. The response has `coalesced: true` for the individual messages so adapters skip duplicate replies.

---

## HTTP Adapter

### Endpoints

#### POST /message

Send a message to a channel and get the response.

```json
// Request
{
  "text": "hello, world",
  "channel": "http-work"
}

// Response
{
  "text": "Hello! How can I help?",
  "duration_ms": 3200
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `text` | string | Yes (or `content`) | — | Plain text message |
| `content` | ContentBlock[] | Yes (or `text`) | — | Multimodal content blocks |
| `channel` | string | No | `"http"` | Channel identifier |

#### POST /send

Push a message to a user through an adapter's native protocol, bypassing ProcessManager.

```json
// Request
{
  "channel": "tg-123456789",
  "text": "Hey! Something happened.",
  "media": {
    "filePath": "/path/to/image.png",
    "type": "photo"
  }
}

// Response
{"status": "sent", "channel": "tg-123456789"}
```

#### GET /healthz

```json
{
  "live": true,
  "ready": true,
  "telegram_enabled": true,
  "warmup": {
    "status": "complete",
    "channels_total": 2,
    "channels_ok": 2,
    "channels_failed": 0,
    "channels_skipped": 0
  }
}
```

#### POST /restart

Triggers a graceful restart. Returns `{"status": "restarting"}`.

---

## Telegram Adapter

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather). Copy the token.
2. Get your user ID from [@userinfobot](https://t.me/userinfobot).
3. Set env vars:
   ```bash
   BARECLAW_TELEGRAM_TOKEN=123456:ABC-DEF...
   BARECLAW_ALLOWED_USERS=your_user_id
   ```
4. Start BAREclaw. The bot connects via long polling — no public URL needed.

### Media Support

**Inbound (Telegram → Claude):**

| Type | Claude Input |
|------|-------------|
| photo | Base64 image + caption |
| document | Text description + file path (images rendered as base64) |
| voice | Text description + file path (duration, size) |
| audio | Text description + file path (title, artist) |
| video | Text description + file path (duration, dimensions, size) |
| video_note | Text description + file path |
| sticker | Base64 image + emoji + set name |
| animation | Text description + file path |

Files are saved to `~/.bareclaw/media/<channel>/`. Max file size: 20MB (Telegram API limit).

**Outbound (Claude → Telegram):** via `POST /send` with a `media` object.

### Output Formatting

- **Status line** — One live in-place message showing tool activity
- **Edits/Writes** — Separate messages with collapsible diffs
- **Questions** — Separate messages with options
- **Final result** — Sent as the response
- **Filler suppressed** — Short text like "Let me check that" is skipped

### Text Message Debouncing

When pasting large text into Telegram (which splits at ~4096 chars), rapid fragments are batched for 300ms and delivered as a single combined message. This prevents governance checks from rejecting each fragment independently.

---

## Thread Commands

All commands are handled by BAREclaw before reaching Claude. Use the `/` prefix. Same topic or DM resumes automatically; these commands are mostly operator controls and escape hatches.

### Status and Info

| Command | Description |
|---------|-------------|
| `/status` | Show provider, model, binding, capability profile, work-item state, continuity health, queue |
| `/help` | Show current thread state plus the full grouped command reference with exact syntax and examples |

### Provider and Model

| Command | Description |
|---------|-------------|
| `/provider [list\|claude\|codex\|ollama\|opencode]` | Switch provider (preserves project continuity) |
| `/model [list\|default\|<model>]` | Change thread model |
| `/mode [list\|auto_resume\|fresh_with_handoff\|warm_lcm_restore\|raw_provider_resume]` | Advanced startup-mode override (`auto_resume` is the default) |

### Project Binding

| Command | Description |
|---------|-------------|
| `/project [<path>]` | Show binding or bind to a vault project path |
| `/project ideas` | Bind to the shared ideas/intake lane |
| `/project ideas-system` | Bind to the system ideas/intake lane |
| `/project intake` / `/project intake-system` | Aliases for ideas/ideas-system |
| `/project bootstrap <id>` | Create a new active project lane and bind to it |
| `/project promote [project_id]` | Promote a queued intake plan to an active project lane |
| `/project clear` | Unbind; next message auto-starts in default ideas lane |

### Work Items

| Command | Description |
|---------|-------------|
| `/workitem auto` | Bind the latest active work item |
| `/workitem <work_item_id>` | Pin to a specific work item |
| `/workitem create <title>` | Create and bind a proposed work item |
| `/workitem start` | Promote proposed work item to active |
| `/workitem verify <v0\|v1\|v2> <pass\|fail> [ref]` | Record verifier evidence |
| `/workitem settle <done\|blocked\|timeout\|killed> [ref]` | Settle the work item |
| `/workitem clear` | Unbind work item, drop to planning-only |

### Artifacts and Continuity

| Command | Description |
|---------|-------------|
| `/artifact draft <title>` | Save latest planning response as a canonical draft artifact |
| `/handoff [<summary>\|clear]` | Store or clear a manual handoff override |
| `/checkpoint [refresh]` | Inspect or refresh the latest automatic checkpoint |

### Approval Workflow

| Command | Description |
|---------|-------------|
| `/approval list [status]` | List approval requests for current project |
| `/approval request <title>` | Queue an execution approval request |
| `/approval approve <id> [note]` | Approve a request |
| `/approval deny <id> [note]` | Deny a request |

### Session Management

| Command | Description |
|---------|-------------|
| `/new` | Start fresh on the next spawn in the same lane |
| `/reset` | Clear raw provider session (project continuity preserved) |
| `/reset --full` | Clear session and project continuity; next message auto-starts in ideas lane |

---

## Capability Modes

The thread's capability profile determines what you can do:

| Mode | Tool Access | Description |
|------|------------|-------------|
| `unbound` | None | Send any message to auto-bind |
| `intake_capture` | Read-only | Capture ideas, read code, plan, research |
| `planning_only` | Read-only | Bound to active project but no work item |
| `approval_pending` | Read-only | Waiting on operator approval |
| `execution_ready` | Full | Active work item bound — full read/write/execute |
| `run_lock_blocked` | Read-only | Another agent run holds the lock |

### Auto-Binding

Unbound threads auto-bind on the next ordinary message:

- **System-flavored** (mentioning bareclaw, mcp, agent system, etc.) → `obsidian/system-incubator`
- **Everything else** → `shared/non-system-incubator`

Both are intake lanes — you land in `intake_capture` (read-only).

### Progressing to Execution

1. **Capture and plan** in intake mode (read-only)
2. `/project promote` — promote to active project lane
3. `/project bootstrap <workspace>/<project>` — or create a new lane directly
4. `/workitem auto` or `/workitem create <title>` — bind a work item
5. Now in `execution_ready` — full write access

---

## Providers

### Claude (Default)

- **ID:** `claude`
- **Command:** `claude -p`
- **Cost:** Routes through Claude Max subscription (flat-rate)
- **Capabilities:** Vision, tools, streaming, session resume

### Codex

- **ID:** `codex`
- **Command:** Bridge script (`node src/providers/codex-bridge.ts`)
- **Models:** `o3`, `o4-mini`, `gpt-5.3-codex` (default), `codex-mini`
- **Capabilities:** Vision, tools, streaming, session resume

### Ollama

- **ID:** `ollama`
- **Command:** Bridge script (`node src/providers/ollama-bridge.ts`)
- **Models:** `gemma3:4b`, `qwen3:4b` (default), `qwen3-vl:8b`, `gpt-oss:20b`
- **Capabilities:** Tools, streaming, session resume (no vision)

### OpenCode

- **ID:** `opencode`
- **Command:** Bridge script (`node src/providers/opencode-bridge.ts`)
- **Models:** provider-default unless OpenCode config or `BARECLAW_OPENCODE_MODEL` sets one
- **Capabilities:** Tools, streaming, session resume (no vision)
- **Skill roots:** inherited from the local OpenCode config, which already points at the shared Codex skill library on this machine

### Switching Providers

```
/provider list          # Show available providers
/provider claude        # Switch to Claude
/provider codex         # Switch to Codex
/provider ollama        # Switch to Ollama
/provider opencode      # Switch to OpenCode
```

Switching resets the raw provider session but preserves project continuity.

---

## Heartbeat and Supervised Mode

### Supervised Mode

When `BARECLAW_SUPERVISED=1`, the daemon is managed by launchd (macOS) or systemd (Linux). Restart exits cleanly (code 0) and lets the OS supervisor replace it.

### Heartbeat

Built-in hourly heartbeat on the `"heartbeat"` channel:

1. Checks `/healthz`
2. Restarts the daemon if needed
3. Runs a read-only triage prompt
4. Pushes a notification only when the response starts with `ATTENTION:`

Related background jobs:

- `heartbeat/knowledge-scan.sh` runs after the hourly heartbeat and reports urgent web-memory findings on the `knowledge-scan` channel.
- `heartbeat/com.bareclaw.security-scan.plist` runs the daily security scan at `06:00`.
- Under macOS launchd, unreadable repo files are skipped and logged instead of creating false-positive incidents.

### Installation

```bash
npm run build
bash heartbeat/install.sh
```

Flags:
- `--daemon-only` — Install daemon only
- `--heartbeat-only` — Install heartbeat scheduler only
- `--security-scan-only` — Install the daily security-scan scheduler only

### Uninstall

**macOS:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.bareclaw.daemon.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.bareclaw.heartbeat.plist
rm ~/Library/LaunchAgents/com.bareclaw.daemon.plist
rm ~/Library/LaunchAgents/com.bareclaw.heartbeat.plist
```

**Linux:**
```bash
systemctl --user disable --now bareclaw.service
systemctl --user disable --now bareclaw-heartbeat.timer
rm ~/.config/systemd/user/bareclaw.service
rm ~/.config/systemd/user/bareclaw-heartbeat.{service,timer}
systemctl --user daemon-reload
```

### Logs

- `/tmp/bareclaw-daemon.log`
- `/tmp/bareclaw-heartbeat.log`
- `/tmp/bareclaw-knowledge-scan.log`
- `/tmp/bareclaw-security-scan.log`
- `/tmp/bareclaw-security-scan-stdout.log`
- `/tmp/bareclaw-security-scan-stderr.log`

---

## Self-Restart

BAREclaw can restart itself to pick up code changes:

```bash
# HTTP
curl -X POST localhost:3000/restart

# Signal
kill -HUP <pid>
```

When `BARECLAW_SUPERVISED=1`, restart exits cleanly and lets launchd/systemd replace the daemon. Unsupervised runs re-exec in place.

---

## Authentication

BAREclaw has shell access. Every channel that can reach it can run arbitrary commands.

- **HTTP:** Set `BARECLAW_HTTP_TOKEN`. All HTTP endpoints except `/healthz` reject requests without `Authorization: Bearer <token>`.
- **Telegram:** `BARECLAW_ALLOWED_USERS` is mandatory. Messages from unlisted users are silently dropped.

---

## Build and Scripts

```bash
npm run dev      # Hot-reload development with tsx
npm run build    # Compile to dist/
npm start        # Run compiled JS
npm test         # Run tests with vitest
```

---

## Troubleshooting

### Session Not Resuming

```bash
ls -la .bareclaw-*.json
cat .bareclaw-sessions.json | jq .
```

### Stalled Turn Not Auto-Recovering

Default idle threshold is 15 minutes (`BARECLAW_STALLED_TURN_IDLE_MS=900000`). Set to `0` to disable. Check logs:

```bash
tail -f /tmp/bareclaw-daemon.log
```

### Telegram Bot Not Responding

1. Verify `BARECLAW_TELEGRAM_TOKEN` is valid
2. Verify `BARECLAW_ALLOWED_USERS` includes your user ID (check via [@userinfobot](https://t.me/userinfobot))
3. Check logs: `grep "telegram" /tmp/bareclaw-daemon.log`

### High Token Usage

Exact raw-session resumes can re-send conversation history, but BAREclaw now prefers live reconnect and continuity before falling back there. Use `/new` to start fresh in the same lane, or `/reset` to clear the saved raw provider session. Claude uses prompt caching — cache reads cost 10% of base input tokens.

---

## Writing a New Adapter

Adapters are intentionally thin:

1. **Derive a channel key** from the protocol's natural session boundary. Prefix with an adapter identifier (`ws-`, `discord-`, etc.).
2. **Build a `ChannelContext`** with channel, adapter name, and metadata (user name, chat title).
3. **Call `processManager.send(channel, content, context)`** and await the result.
4. **Do not implement your own queuing.** ProcessManager owns all concurrency.
5. **Check `response.coalesced`** — if true, skip sending a response.

See `src/adapters/telegram.ts` as the reference implementation and `src/adapters/http.ts` as the minimal case.

---

## Examples

### Telegram: Intake to Execution

```
/status                                          # Check current state
> planning_only, bound to shared/non-system-incubator

I need to refactor the auth module                # Plan in read-only mode
> [reads files, analyzes structure, proposes plan]

/artifact draft Auth Refactor Plan                # Save the plan
> Draft artifact saved

/approval request Refactor auth module            # Request execution approval
> Approval request queued: req-abc123

/approval approve req-abc123                      # Approve it
> Approved. Work item created and bound.

Let's start with the user model                   # Now in execution_ready
> [edits files, runs tests, full write access]

/workitem settle done                             # Mark complete
> Work item settled as done.
```

### HTTP: Send a Message

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "what time is it?", "channel": "http-work"}'
```

### HTTP: Send with Image

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "http-work",
    "content": [
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "'$(base64 < image.png)'"}},
      {"type": "text", "text": "What is this?"}
    ]
  }'
```

### HTTP: Push a Proactive Message

```bash
curl -X POST localhost:3000/send \
  -H 'Content-Type: application/json' \
  -d '{"channel": "tg-123456789", "text": "Your task is done!"}'
```
