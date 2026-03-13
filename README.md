# BAREclaw

One daemon, many mouths, one brain. The bare minimum between you and your AI.

BAREclaw is a thin daemon that multiplexes input channels (HTTP, Telegram, SMS, etc.) into persistent Claude Code CLI processes. Every channel gets its own session with full context, tools, skills, MCP servers, and CLAUDE.md. Responses come back out the same way they came in.

The key design choice: BAREclaw shells out to `claude -p` rather than using the Agent SDK. CLI shelling goes through the Claude Max subscription (flat-rate unlimited). The SDK bills per API token. For a personal daemon, the marginal cost is $0.

The key design consequence: Claude running through BAREclaw has full tool access, including `Bash`, `Write`, and `Edit`. It can modify BAREclaw's own source code and trigger a restart to pick up the changes. BAREclaw is the simplest thing that could build itself.

## Quick start

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

First message per channel is slow (~15-30s, spawning claude). Subsequent messages reuse the warm process (3-5s).

## Architecture

```
[curl / Shortcut / Telegram / SMS / ...]
    → adapter (translates channel protocol → internal API)
        → ProcessManager.send(channel, content, context?)
            → session host (detached process per channel)
                → persistent claude process
        ← { text, duration_ms }
    ← response via same channel
```

```
src/
  index.ts                 # Entry point: Express server, Telegram bot, signals, self-restart
  config.ts                # Env var loading with defaults and type conversion
  core/
    types.ts               # Protocol types (ClaudeInput, ClaudeEvent, ChannelContext, etc.)
    session-host.ts        # Detached process holding a single Claude session, communicates via Unix socket
    process-manager.ts     # THE core — manages channels, spawns/connects session hosts, FIFO dispatch
    push-registry.ts       # Routes outbound push messages (POST /send) to the right adapter
  adapters/
    http.ts                # POST /message, POST /restart, GET /healthz, optional Bearer auth
    telegram.ts            # Telegraf bot, long polling, required user allowlist
```

**ProcessManager** is the only file with real complexity. One persistent Claude process per channel, lazy-spawned, with strict FIFO queuing per channel and auto-reconnect to session hosts. It is deliberately adapter-agnostic — it accepts an opaque channel string and handles everything else.

**Session hosts** are detached processes that each hold a single Claude session. They communicate with ProcessManager via Unix domain sockets and survive server hot reloads — only a full shutdown (Ctrl+C / SIGINT) kills them.

**Adapters** are thin. Their only jobs are: (1) derive a channel key from the protocol's natural session boundary, (2) build a `ChannelContext` with adapter metadata, (3) call `processManager.send(channel, content, context)`, and (4) format the response for the client. Adapters must not implement their own queuing, session management, or concurrency control — ProcessManager owns all of that.

## Channels

A **channel** is the fundamental unit of session identity. Each unique channel string maps to exactly one persistent Claude process, one FIFO message queue, and one resumable session ID.

Channels are the **only abstraction ProcessManager knows about**. It has zero awareness of adapters, protocols, or where messages come from. This is a deliberate design constraint — it means every adapter gets the same queuing, dispatch, and session-persistence behavior for free, with no adapter-specific code paths inside the core.

### Channel properties

- **Adapter-agnostic.** The channel key is an opaque string. ProcessManager never parses, validates, or inspects it. Two adapters using the same channel key talk to the same Claude session — this is a feature, not a bug.
- **One queue per channel.** Each channel has its own independent FIFO queue. Messages sent to different channels are fully concurrent. Messages sent to the _same_ channel are serialized.
- **Persistent across restarts.** BareClaw saves per-channel runtime state in `.bareclaw-channel-state.json` and saved raw provider sessions in `.bareclaw-sessions.json`. When you return to the same channel, it tries live reconnect first, then saved raw session resume, then continuity fallback.

### Channel key conventions

Adapters derive channel keys from whatever their natural session boundary is. The key rules:

1. **Prefix with a short adapter identifier** (`http-`, `tg-`, `ws-`, etc.) to avoid collisions between adapters.
2. **One channel per independent conversation context.** A Telegram chat, a Discord thread, a WebSocket connection — each gets its own channel.
3. **Never hardcode a single channel for an entire adapter.** Every adapter must support multiple simultaneous channels.
4. **Keep keys short and filesystem-safe.** Channel keys end up in Unix socket paths (`/tmp/bareclaw-<channel>.sock`), so avoid special characters.

**Current adapters:**

| Adapter | Channel key | Derived from |
|---------|------------|--------------|
| HTTP | Caller-controlled via `channel` field. Defaults to `"http"`. | Request body |
| Telegram | `tg-<chatId>` (DMs/groups) or `tg-<chatId>-<threadId>` (forum topics) | `ctx.chat.id` + `message_thread_id` |

> **Pro tip:** Telegram supergroups with **Topics** enabled give you multiple independent Claude sessions in one group. Each topic gets its own channel (keyed as `tg-<chatId>-<threadId>`), so topics like "Code Review", "Research", "Ops" each get a persistent session with isolated context.

## Concurrency model

BAREclaw handles multiple simultaneous messages correctly, whether they arrive on the same channel or different channels:

### Different channels → fully concurrent

Each channel has its own session host process, socket connection, and queue. Messages to `tg-123` and `tg-456` are dispatched in parallel with zero interaction. There is no global lock.

### Same channel → strict FIFO

Within a single channel, messages are processed **one at a time, in arrival order**. This is enforced by the `busy` flag and queue in ProcessManager:

1. First message arrives → channel is idle → dispatch immediately, set `busy = true`.
2. Second message arrives while first is processing → `busy` is true → push to queue, return a pending promise.
3. First message completes (`result` event) → set `busy = false` → `drainQueue()` shifts the next message and dispatches it.
4. Repeat until queue is empty.

This is not a limitation — it's a requirement. Claude's NDJSON stdio protocol is a single sequential stream. Sending a second message before the first completes would corrupt the stream and produce undefined behavior.

### Rapid-fire messages and coalescing

When a user sends multiple messages while a channel is busy, they queue up. Rather than processing each as a separate Claude turn, `drainQueue()` **coalesces** all waiting messages into a single turn — their text is joined with double newlines and dispatched as one message. This handles the common pattern of sending fragmented thoughts in quick succession.

How it works:

1. Messages arrive while channel is busy → queued normally.
2. Current turn finishes → `drainQueue()` takes **all** queued messages at once.
3. If multiple: combine text, resolve earlier callers' promises with `{ coalesced: true }`, dispatch combined text with the last caller's `onEvent` callback.
4. If only one: dispatch normally (no coalescing overhead).

Adapters check `response.coalesced` and skip sending a response for those messages — the combined message's handler takes care of it. Zero latency added to the happy path (idle channel → immediate dispatch).

## Writing a new adapter

Adapters are intentionally thin. Here's the contract:

1. **Derive a channel key** from the protocol's natural session boundary. Prefix it with an adapter identifier (e.g., `ws-`, `discord-`). See channel key conventions above.
2. **Build a `ChannelContext`** with channel, adapter name, and any available metadata (user name, chat title, topic). This is prepended to every message so Claude knows where it's coming from.
3. **Call `processManager.send(channel, content, context)`** and await the result. That's it for the core interaction — ProcessManager handles spawning, queuing, session persistence, and reconnection.
4. **Do not implement your own queuing or concurrency control.** ProcessManager owns all of that. If two messages arrive simultaneously for the same channel, both `send()` calls will resolve correctly in order.
5. **Handle your own output ordering** if the adapter streams intermediate events. The `onEvent` callback fires for every Claude event (assistant messages, tool use, etc.) before the final result. If your protocol delivers these to the user, chain the sends to preserve order (see the Telegram adapter's `sendChain` pattern).
6. **Handle errors from `send()`** — it can reject if the session host disconnects.
7. **Check `response.coalesced`** — if true, this message was folded into a subsequent turn. Skip sending a response.

See `src/adapters/telegram.ts` as the reference implementation and `src/adapters/http.ts` as the minimal case.

## Protocol

Messages in (NDJSON on stdin). When a `ChannelContext` is provided, ProcessManager prepends a metadata prefix to the content so Claude knows which channel, adapter, and user the message came from:
```json
{"type":"user","message":{"role":"user","content":"[channel: tg-123, adapter: telegram, user: Alice]\nhello"}}
```

Results out (NDJSON on stdout):
```json
{"type":"result","result":"Hello!","duration_ms":4200}
```

Process stays alive between messages. Session context preserved automatically.

## Configuration

All configuration is via environment variables. Everything has a sensible default — BAREclaw works with zero config for localhost use. See `.env.example` for the full list.

| Variable | Default | Description |
|---|---|---|
| `BARECLAW_PORT` | `3000` | HTTP server port |
| `BARECLAW_CWD` | `$HOME` | Working directory for `claude` processes. Determines which `CLAUDE.md` and project context Claude sees. |
| `BARECLAW_MAX_TURNS` | `25` | Max agentic turns per message. Prevents runaway tool loops. |
| `BARECLAW_ALLOWED_TOOLS` | `Read,Glob,Grep,Bash,Write,Edit,Skill,Task` | Tools auto-approved without interactive confirmation. Comma-separated. |
| `BARECLAW_TIMEOUT_MS` | `0` | Per-message timeout. **Must be `0` (no timeout).** Sessions are persistent and agentic — responses can take minutes. A non-zero value kills the socket mid-response and corrupts channel state. |
| `BARECLAW_STALLED_TURN_IDLE_MS` | `900000` | If a busy turn produces no output for this long, BAREclaw sends one automatic interrupt. Set to `0` to disable stalled-turn recovery. |
| `BARECLAW_STALLED_TURN_INTERRUPT_GRACE_MS` | `30000` | After the automatic interrupt, how long to wait for fresh activity before resetting that channel. |
| `BARECLAW_STALLED_TURN_POLL_MS` | `15000` | How often BAREclaw checks busy channels for stalled-turn recovery. |
| `BARECLAW_SESSION_FILE` | `.bareclaw-sessions.json` | Saved raw provider session map used by `auto_resume` and `raw_provider_resume` recovery. |
| `BARECLAW_CHANNEL_STATE_FILE` | `.bareclaw-channel-state.json` | Per-thread runtime state: provider, model, startup mode, project/work-item binding, resume source, and continuity metadata. |
| `BARECLAW_CONTINUITY_BRIDGE` | *(none)* | Optional path to the obsidian-mcp bridge script that writes canonical checkpoint/handoff artifacts and assembles startup continuity from project memory. |
| `BARECLAW_CONTINUITY_PYTHON` | `python3` | Python binary used to execute the continuity bridge. |
| `BARECLAW_HTTP_TOKEN` | *(none)* | Bearer token for HTTP auth. Required for all HTTP endpoints except `/healthz`. |
| `BARECLAW_TELEGRAM_TOKEN` | *(none)* | Telegram bot token from @BotFather. Omit to disable Telegram entirely. |
| `BARECLAW_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs. **Required** when Telegram is enabled. |
| `BARECLAW_HEARTBEAT_NOTIFY_CHANNEL` | *(auto)* | Optional explicit push target for `ATTENTION:` heartbeat responses. When unset, install falls back to the first `BARECLAW_ALLOWED_USERS` entry. |

### Setting `BARECLAW_CWD`

This controls the project context for all `claude` processes:

- `~/dev/myproject` — Claude sees that project's `CLAUDE.md`, can read/edit its files, runs tools in that directory
- `~` — Claude sees your global `~/.claude/CLAUDE.md` and can access anything in your home directory
- Set to BAREclaw's own directory for self-modification

## Telegram thread controls

Telegram threads now carry their own persisted runtime state separate from raw provider chat history. Same DM or topic resumes automatically. Plain English is the normal path: say "start planning", "make the work item", "get to work", or "promote this project". Slash commands remain available as operator tools. Unbound threads auto-start in the default ideas lane on the next ordinary message unless you override that binding explicitly.

These commands operate on the current DM, group, or forum topic channel:

- `/status` — show provider, model, startup mode, binding status, capability profile, tool mode, write state/reason/remediation, work-item mode/selection mode, continuity source/sync health, and queue/busy state
- `/help` — show the current thread state plus the full grouped command reference with exact syntax and good/bad examples
- `/provider [list|claude|codex|ollama]` — switch provider for the thread and reset only the raw provider session
- `/model [list|default|<model>]` — change the thread model when the selected provider exposes known models
- `/mode [list|auto_resume|fresh_with_handoff|warm_lcm_restore|raw_provider_resume]` — advanced startup override; the default is `auto_resume`
- `/project <vault project path>` — bind the thread to a project path and reset the live/raw provider session so the next turn starts from that project
- `/project ideas` — bind the thread to the default shared ideas lane
- `/project ideas-system` — bind the thread to the system ideas lane
- `/project intake` — bind the thread to the default shared incubator lane
- `/project intake-system` — bind the thread to the system incubator lane
- `/project bootstrap <project_id|workspace_id/project_id|vault project path>` — create a brand-new active project lane, seed canonical continuity there, and keep the thread in planning-only mode; when a workspace is already implied by the current binding, `<project_id>` is enough
- `/project promote [project_id]` — when bound to a queued-plan path under an intake lane, either promote it into `0 Agent Vault/Agents/10_Projects/<workspace_id>/<project_id>` immediately or queue an in-chat promotion approval when policy requires it
- `/artifact draft <title>` — write the latest assistant planning response into a canonical draft artifact for the current active project lane
- `/approval list [status]` — list approval requests for the current project lane (or the current filter)
- `/approval request <work_item_title>` — queue an in-chat execution approval request tied to the current project lane and latest planning context
- `/approval approve <request_id> [note]` — approve a queued execution request and create/bind the corresponding proposed work item, or approve a queued promotion request and activate the target project lane
- `/approval deny <request_id> [note]` — deny a queued execution request while leaving the thread in planning-only mode
- `/project clear` — clear stored project continuity and the raw provider session; the next ordinary message will auto-start in the default ideas lane unless you choose another project first
- `/workitem auto` — bind the latest canonical active work item for the current project and reset the raw provider session
- `/workitem create <title>` — explicitly create or bind a proposed work item for the current project and reset the raw provider session
- `/workitem <work_item_id>` — pin the thread to a specific active work item for the current project
- `/workitem start` — promote the current proposed work item to `active`
- `/workitem verify <v0|v1|v2> <pass|fail> [best_artifact_ref|failure_mode]` — record verifier evidence for the active work item through the canonical MCP ledger
- `/workitem settle <done|blocked|timeout|killed> [best_artifact_ref|failure_mode]` — settle the active work item through the canonical MCP ledger
- `/workitem clear` — clear the current work-item binding, downgrade the thread to planning-only, and show the resulting capability/remediation state
- `/handoff <summary>` — store a manual bounded handoff override for the next fresh start
- `/handoff clear` — clear the manual handoff override and fall back to the automatic handoff
- `/checkpoint` — inspect the latest automatic checkpoint captured for the thread
- `/checkpoint refresh` — refresh the timestamp on the stored automatic checkpoint
- `/new` — force the next spawn to start fresh in the same lane while keeping the current project and work-item binding
- `/reset` — clear only the raw provider session for this thread
- `/reset --full` — clear both the raw provider session and stored project continuity; the next ordinary message will auto-start in the default ideas lane unless you choose another project first

Notes:

- `auto_resume` is the default. BareClaw reconnects the live session when possible, then tries any saved raw provider session, then falls back to canonical/local continuity.
- `fresh_with_handoff` ignores saved raw provider sessions on new spawns and injects stored continuity instead.
- `warm_lcm_restore` now attempts an LCM restore/init through the configured continuity bridge, then falls back to canonical handoff + checkpoint context if LCM is unavailable.
- `raw_provider_resume` reuses the saved provider session when one exists.
- The first reply after a reconnect or fresh spawn includes a short session note: `session: resumed exact`, `session: resumed saved session`, `session: resumed continuity`, or `session: started fresh`.
- If a thread is unbound, BareClaw auto-binds the next ordinary message into an ideas lane. System-flavored threads go to the system ideas lane; everything else defaults to the shared ideas lane.
- `/project bootstrap` accepts `<workspace_id>/<project_id>` from an unbound thread, or just `<project_id>` when the current binding already implies the workspace (for example a workspace root or intake lane).
- Bound project threads without an active work item stay in planning/discovery mode. On execution-like requests, BareClaw now evaluates policy automatically: if approval is required it auto-writes/reuses the latest planning draft, auto-queues approval, and surfaces `approval_pending`; if approval is not required it can still bind/create the work item directly. Manual `/artifact draft <title>`, `/approval request <work_item_title>`, `/workitem auto`, `/workitem create <title>`, and `/workitem <id>` commands remain available as operator controls.
- BareClaw uses the final segment of the bound `/project` path as `project_id` for work-item lookup. If you bind a parent/root folder, work-item commands will not cross into child project ids; bind the leaf execution project path instead.
- `/project promote` currently requires the thread to be bound to a queued-plan path under `20_Queued_Plans`. If BareClaw cannot derive a stable slug from that path, pass `/project promote <project_id>`. When intake metadata still requires human review, BareClaw queues `intake_project_promote` approval instead of rebinding immediately.
- Work items in `blocked`, `done`, `timeout`, or `killed` state no longer count as execution-ready. Those threads fall back to read-only planning mode until you bind or create a new eligible work item.
- Blocked write attempts now return structured guidance with `capability_profile`, `tool_mode`, `write_state`, `reason`, and `remediation` instead of generic execution failures.
- Provider-side capability enforcement is fail-closed: `planning_only`, `intake_capture`, and `run_lock_blocked` threads stay read-only even if the provider tries to reach a write-capable tool path.
- BareClaw now writes an automatic checkpoint and automatic handoff after completed turns. With `BARECLAW_CONTINUITY_BRIDGE` configured, those are flushed to canonical Obsidian artifacts under the project lane and reused on future cold starts.
- Auto-created proposed work items are promoted to `active` automatically after the first successful write-capable turn, and the explicit `/workitem` lifecycle commands now route through the canonical MCP work-item ledger rather than local thread state.
- Manual `/handoff` still overrides startup continuity for the current thread, but ordinary recovery no longer depends on remembering to run it.
- `/new` is the explicit fresh-start escape hatch for users; `/mode` remains available for advanced debugging and operator overrides.

## Authentication

BAREclaw has shell access. Every channel that can reach it can run arbitrary commands.

- **HTTP**: set `BARECLAW_HTTP_TOKEN`. All HTTP endpoints except `/healthz` reject requests without `Authorization: Bearer <token>`.
- **Telegram**: `BARECLAW_ALLOWED_USERS` is mandatory — BAREclaw refuses to start without it. Messages from users not on the allowlist are silently dropped.
- All channels share the same `--allowedTools` set (no per-channel restrictions in V1).

## Self-restart

BAREclaw can restart itself to pick up code changes:

- `POST /restart` — HTTP endpoint
- `kill -HUP <pid>` — SIGHUP signal
- Claude can trigger either via Bash

When `BARECLAW_SUPERVISED=1`, restart exits cleanly and lets launchd/systemd replace the daemon. Unsupervised runs still self-reexec in place. `GET /healthz` reports `live`, `ready`, Telegram availability, and startup warm-up progress.

## Heartbeat

BAREclaw includes two background pieces:

- **Daemon service**: `node --env-file=.env dist/index.js` under launchd (macOS) or a user systemd service (Linux). It runs with `BARECLAW_SUPERVISED=1`, `RunAtLoad`/`WantedBy=default.target`, and automatic restart.
- **Heartbeat**: an hourly scheduled job on the `"heartbeat"` channel that checks `/healthz`, restarts the managed daemon if needed, runs a read-only triage prompt, and only pushes a notification when the response starts with `ATTENTION:`.
- **Knowledge scan**: an hourly lightweight web-memory health check that runs after the heartbeat and reports urgent knowledge findings on the `knowledge-scan` channel.
- **Security scan**: an hourly lightweight scan plus a daily deep scan. Under launchd, unreadable repo files are skipped and logged instead of producing false-positive incidents.

Startup warm-up is opt-in through:

- `BARECLAW_WARM_CHANNELS=tg-123,tg-456`
- `BARECLAW_WARMUP_DELAY_MS=5000`

Warm-up reconnects or spawns saved channel session hosts after the daemon comes up, without sending Telegram messages to the user.

The heartbeat session is persistent and separate from all user-facing channels. It accumulates context, but the scheduled heartbeat itself stays read-only and uses `/send` from the shell wrapper only after an `ATTENTION:` response. You can still message the channel directly to add reminders or recurring checks:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "Every heartbeat, check if there are any new files in ~/Downloads that need organizing", "channel": "heartbeat"}'
```

### Files

```
heartbeat/
  com.bareclaw.daemon.plist       # macOS launchd daemon template
  heartbeat.sh                    # Runner: checks server health, runs read-only triage, forwards ATTENTION notifications
  knowledge-scan.sh               # Lightweight web-memory assurance scan
  security-scan.sh                # Repo security scan with hourly and daily modes
  install.sh                      # Detects OS, installs the appropriate scheduled job
  bareclaw.service                # Linux systemd user daemon service
  com.bareclaw.heartbeat.plist    # macOS launchd template
  com.bareclaw.security-scan.plist # macOS launchd template for daily security scan
  bareclaw-heartbeat.service      # Linux systemd oneshot service
  bareclaw-heartbeat.timer        # Linux systemd timer (1h interval)
```

### Manual install

Build first, then install the managed daemon plus heartbeat:

```bash
npm run build
bash heartbeat/install.sh
```

Flags:

- `bash heartbeat/install.sh --daemon-only`
- `bash heartbeat/install.sh --heartbeat-only`
- `bash heartbeat/install.sh --security-scan-only`

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

### Customize

Edit `heartbeat/heartbeat.sh` to change the triage prompt or notification behavior. Edit the interval in the plist (`StartInterval` in seconds) or timer (`OnUnitActiveSec`). Re-run `install.sh` after changing service templates.

On macOS, launchd jobs are staged under `~/Library/Application Support/BAREclaw/heartbeat/` before install. This avoids executing the scheduled scripts directly from a protected repo path.

Logs:

- `/tmp/bareclaw-daemon.log`
- `/tmp/bareclaw-heartbeat.log`
- `/tmp/bareclaw-knowledge-scan.log`
- `/tmp/bareclaw-security-scan.log`
- `/tmp/bareclaw-security-scan-stdout.log`
- `/tmp/bareclaw-security-scan-stderr.log`

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. Copy the token.
2. Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).
3. Set environment variables:
   ```bash
   BARECLAW_TELEGRAM_TOKEN=123456:ABC-DEF...
   BARECLAW_ALLOWED_USERS=your_user_id
   BARECLAW_HEARTBEAT_NOTIFY_CHANNEL=tg-your_user_id
   ```
4. Start BAREclaw. The bot connects via long polling — no public URL needed.

## Build

```bash
npm run build   # compile to dist/
npm start       # run compiled JS
```

## Why not the Agent SDK?

The Claude Agent SDK bills per API token — every prompt and response is metered. BAREclaw shells out to `claude -p` instead, which routes through the **Claude Max subscription** (flat-rate unlimited). For a personal daemon that fields dozens of prompts a day, the marginal API cost is $0.

The tradeoff: you depend on the CLI's IPC protocol (stream-JSON over stdio), which is less stable than a versioned SDK API. For a personal tool, this is fine.
