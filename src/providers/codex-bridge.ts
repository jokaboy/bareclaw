import { createInterface } from 'readline';
import { Codex } from '@openai/codex-sdk';
import {
  capabilityProfileToToolMode,
  type CapabilityProfile,
  type ProviderToolMode,
} from './capability.js';
import { denyCodexEvent } from './provider-gates.js';

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const cwd = getArg('--cwd') || process.cwd();
const resumeId = getArg('--resume');
const systemPrompt = getArg('--system-prompt');
const modelArg = getArg('--model');
const capabilityProfile = (getArg('--capability-profile') || 'planning_only') as CapabilityProfile;
const toolMode = (getArg('--tool-mode') || capabilityProfileToToolMode(capabilityProfile)) as ProviderToolMode;

const codex = new Codex();
const threadOpts = {
  model: modelArg || process.env.BARECLAW_CODEX_MODEL || undefined,
  workingDirectory: cwd,
  approvalPolicy: 'never' as const,
  sandboxMode: toolMode === 'full' ? 'workspace-write' as const : 'read-only' as const,
  networkAccessEnabled: toolMode === 'full' ? undefined : false,
  webSearchEnabled: false,
  skipGitRepoCheck: true,
};

let thread: any;
if (resumeId) {
  thread = codex.resumeThread(resumeId, threadOpts);
} else {
  thread = codex.startThread(threadOpts);
}

let isFirstTurn = true;

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function normalize(event: any): Record<string, unknown> | null {
  switch (event.type) {
    case 'thread.started':
    case 'turn.started':
    case 'item.updated':
      return null;
    case 'item.started': {
      const item = event.item;
      if (item.type === 'command_execution') {
        return {
          type: 'assistant',
          subtype: 'tool_use',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              name: 'Bash',
              input: { command: item.command },
            }],
          },
        };
      }
      if (item.type === 'mcp_tool_call') {
        return {
          type: 'assistant',
          subtype: 'tool_use',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              name: `mcp__${item.server}__${item.tool}`,
              input: item.arguments,
            }],
          },
        };
      }
      return null;
    }
    case 'item.completed': {
      const item = event.item;
      if (item.type === 'agent_message') {
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: item.text }],
          },
        };
      }
      if (item.type === 'command_execution') {
        return {
          type: 'assistant',
          subtype: 'tool_result',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              name: 'Bash',
              output: item.aggregated_output || '',
              exit_code: item.exit_code,
            }],
          },
        };
      }
      if (item.type === 'file_change') {
        const paths = item.changes.map((change: any) => `${change.kind}: ${change.path}`).join(', ');
        return {
          type: 'assistant',
          subtype: 'tool_result',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              name: 'Edit',
              output: paths,
            }],
          },
        };
      }
      if (item.type === 'mcp_tool_call') {
        const output = item.result
          ? JSON.stringify(item.result.content)
          : item.error?.message || 'unknown error';
        return {
          type: 'assistant',
          subtype: 'tool_result',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              name: `mcp__${item.server}__${item.tool}`,
              output,
            }],
          },
        };
      }
      return null;
    }
    case 'turn.completed':
      return {
        type: 'result',
        result: '',
        session_id: thread.id,
        is_error: false,
        usage: event.usage,
      };
    case 'turn.failed':
      return {
        type: 'result',
        result: `Codex turn failed: ${event.error?.message || 'unknown error'}`,
        session_id: thread.id,
        is_error: true,
      };
    case 'error':
      return {
        type: 'result',
        result: `Codex error: ${event.message || 'unknown'}`,
        session_id: thread.id,
        is_error: true,
      };
    default:
      return null;
  }
}

function shouldDenyEvent(event: any): string | null {
  return denyCodexEvent(event, capabilityProfile, toolMode);
}

async function handleTurn(userText: string): Promise<void> {
  let input = userText;
  if (isFirstTurn && systemPrompt) {
    input = `${systemPrompt}\n\n---\n\n${userText}`;
  }
  isFirstTurn = false;

  try {
    const abortController = new AbortController();
    const streamed = await thread.runStreamed(input, { signal: abortController.signal });
    let finalText = '';
    let capabilityDenied = false;

    for await (const event of streamed.events) {
      const deniedMessage = shouldDenyEvent(event);
      if (deniedMessage) {
        capabilityDenied = true;
        emit({
          type: 'result',
          result: deniedMessage,
          session_id: thread.id,
          is_error: true,
        });
        abortController.abort();
        break;
      }

      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        finalText += (finalText ? '\n' : '') + event.item.text;
      }

      const normalized = normalize(event);
      if (!normalized) continue;

      if (normalized.type === 'result' && !normalized.is_error) {
        normalized.result = finalText;
      }

      emit(normalized);
    }
    if (capabilityDenied) return;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }
    emit({
      type: 'result',
      result: `Codex bridge error: ${err instanceof Error ? err.message : String(err)}`,
      session_id: thread.id,
      is_error: true,
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnChain: Promise<void> = Promise.resolve();
let pendingTurns = 0;
let stdinClosed = false;

function maybeExit(): void {
  if (stdinClosed && pendingTurns === 0) {
    process.exit(0);
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line) as {
      type?: string;
      message?: { content?: string | Array<{ type?: string; text?: string }> };
    };

    if (msg.type !== 'user' || !msg.message) return;

    const content = msg.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text as string)
        .join('\n');
    }

    if (!text.trim()) return;

    pendingTurns++;
    turnChain = turnChain
      .then(() => handleTurn(text))
      .finally(() => {
        pendingTurns--;
        maybeExit();
      });
  } catch {}
});

rl.on('close', () => {
  stdinClosed = true;
  void turnChain.finally(maybeExit);
});
