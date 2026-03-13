import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  capabilityProfileToToolMode,
  formatCapabilityDeniedMessage,
  type CapabilityProfile,
  type ProviderToolMode,
} from './capability.js';
import {
  buildBareClawOpenCodeEnv,
  loadOpenCodeBaseConfig,
  resolveOpenCodeAgentName,
  resolveOpenCodeConfigPath,
} from './opencode-config.js';

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

let lastSessionId = resumeId;
let isFirstTurn = true;
let sharedEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function buildUserTurn(text: string): string {
  if (isFirstTurn && systemPrompt) {
    isFirstTurn = false;
    return `${systemPrompt}\n\n---\n\n${text}`;
  }
  isFirstTurn = false;
  return text;
}

function mapToolName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Tool';
  if (raw === 'bash') return 'Bash';
  return raw;
}

function extractToolOutput(part: Record<string, unknown>): { output: string; exitCode?: number } {
  const state = typeof part.state === 'object' && part.state !== null
    ? part.state as Record<string, unknown>
    : {};
  const metadata = typeof state.metadata === 'object' && state.metadata !== null
    ? state.metadata as Record<string, unknown>
    : {};

  const outputCandidate = typeof metadata.output === 'string'
    ? metadata.output
    : typeof state.output === 'string'
      ? state.output
      : typeof state.title === 'string'
        ? state.title
        : '';

  const exit = metadata.exit;
  return {
    output: outputCandidate,
    exitCode: typeof exit === 'number' ? exit : undefined,
  };
}

function isPermissionAskedEvent(event: Record<string, unknown>): boolean {
  const type = event.type;
  if (type === 'permission.asked' || type === 'permission_asked') {
    return true;
  }
  const part = typeof event.part === 'object' && event.part !== null ? event.part as Record<string, unknown> : undefined;
  return part?.type === 'permission';
}

function extractDeniedAction(event: Record<string, unknown>): string {
  const part = typeof event.part === 'object' && event.part !== null ? event.part as Record<string, unknown> : {};
  const tool = part.tool;
  if (typeof tool === 'string' && tool.trim()) {
    return mapToolName(tool);
  }
  const title = part.title;
  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }
  return 'OpenCode permission request';
}

async function getSharedEnv(): Promise<NodeJS.ProcessEnv> {
  if (!sharedEnvPromise) {
    sharedEnvPromise = loadOpenCodeBaseConfig(resolveOpenCodeConfigPath())
      .then((config) => ({
        ...process.env,
        ...buildBareClawOpenCodeEnv(config),
      }));
  }
  return sharedEnvPromise;
}

async function handleTurn(userText: string): Promise<void> {
  const input = buildUserTurn(userText);
  const args = ['run', '--format', 'json', '--agent', resolveOpenCodeAgentName(toolMode), '--dir', cwd];

  if (lastSessionId) {
    args.push('--session', lastSessionId);
  }

  if (modelArg) {
    args.push('--model', modelArg);
  }

  args.push(input);

  const child = spawn('opencode', args, {
    cwd,
    env: await getSharedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let finalText = '';
  let stderr = '';
  let permissionDenied = false;
  let emittedTerminalResult = false;

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  stdoutRl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const sessionId = typeof event.sessionID === 'string'
        ? event.sessionID
        : typeof (event.part as Record<string, unknown> | undefined)?.sessionID === 'string'
          ? (event.part as Record<string, unknown>).sessionID as string
          : undefined;
      if (sessionId) {
        lastSessionId = sessionId;
      }

      if (isPermissionAskedEvent(event)) {
        permissionDenied = true;
        emittedTerminalResult = true;
        emit({
          type: 'result',
          result: formatCapabilityDeniedMessage('OpenCode', extractDeniedAction(event), capabilityProfile),
          session_id: lastSessionId,
          is_error: true,
        });
        child.kill('SIGTERM');
        return;
      }

      if (event.type === 'text') {
        const part = typeof event.part === 'object' && event.part !== null ? event.part as Record<string, unknown> : {};
        const text = typeof part.text === 'string' ? part.text : '';
        if (!text) return;
        finalText += text;
        emit({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        });
        return;
      }

      if (event.type === 'tool_use') {
        const part = typeof event.part === 'object' && event.part !== null ? event.part as Record<string, unknown> : {};
        const name = mapToolName(part.tool);
        const state = typeof part.state === 'object' && part.state !== null ? part.state as Record<string, unknown> : {};
        const inputPayload = typeof state.input === 'object' && state.input !== null ? state.input : {};
        emit({
          type: 'assistant',
          subtype: 'tool_use',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name, input: inputPayload }],
          },
        });

        const { output, exitCode } = extractToolOutput(part);
        emit({
          type: 'assistant',
          subtype: 'tool_result',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              name,
              output,
              ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
            }],
          },
        });
        return;
      }

      if (event.type === 'error') {
        emittedTerminalResult = true;
        emit({
          type: 'result',
          result: `OpenCode error: ${typeof event.message === 'string' ? event.message : 'unknown error'}`,
          session_id: lastSessionId,
          is_error: true,
        });
        child.kill('SIGTERM');
      }
    } catch {
      // Ignore malformed lines from the provider bridge.
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (text) {
      stderr += text;
    }
  });

  await new Promise<void>((resolve) => {
    child.on('error', (error) => {
      if (!emittedTerminalResult) {
        emittedTerminalResult = true;
        emit({
          type: 'result',
          result: `OpenCode bridge error: ${error.message}`,
          session_id: lastSessionId,
          is_error: true,
        });
      }
      resolve();
    });

    child.on('close', (code) => {
      if (!emittedTerminalResult && !permissionDenied) {
        const trimmedStderr = stderr.trim();
        if (code && code !== 0) {
          emit({
            type: 'result',
            result: trimmedStderr || `OpenCode exited with code ${code}`,
            session_id: lastSessionId,
            is_error: true,
          });
        } else {
          emit({
            type: 'result',
            result: finalText.trim(),
            session_id: lastSessionId,
            is_error: false,
          });
        }
      }
      resolve();
    });
  });
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
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text as string)
          .join('\n')
        : '';

    if (!text.trim()) return;

    pendingTurns++;
    turnChain = turnChain
      .then(() => handleTurn(text))
      .finally(() => {
        pendingTurns--;
        maybeExit();
      });
  } catch {
    // Ignore malformed inbound messages.
  }
});

rl.on('close', () => {
  stdinClosed = true;
  void turnChain.finally(maybeExit);
});
