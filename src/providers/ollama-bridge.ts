import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  capabilityProfileToToolMode,
  type CapabilityProfile,
  type ProviderToolMode,
} from './capability.js';
import { buildOllamaToolDefs, denyOllamaToolCall } from './provider-gates.js';

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const model = getArg('--model') || process.env.BARECLAW_OLLAMA_MODEL || 'qwen3:4b';
const resumeId = getArg('--resume');
const systemPrompt = getArg('--system-prompt');
const capabilityProfile = (getArg('--capability-profile') || 'planning_only') as CapabilityProfile;
const toolMode = (getArg('--tool-mode') || capabilityProfileToToolMode(capabilityProfile)) as ProviderToolMode;
const ollamaHost = process.env.BARECLAW_OLLAMA_HOST || 'http://localhost:11434';
const sessionId = resumeId || randomUUID();

type HistoryMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: any[] }
  | { role: 'tool'; content: string; tool_call_id: string };

let history: HistoryMessage[] = [];

if (resumeId) {
  try {
    history = JSON.parse(readFileSync(`/tmp/bareclaw-ollama-${resumeId}.json`, 'utf-8')) as HistoryMessage[];
  } catch {}
}

function saveHistory(): void {
  try {
    writeFileSync(`/tmp/bareclaw-ollama-${sessionId}.json`, JSON.stringify(history));
  } catch {}
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const MAX_OUTPUT = 50_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.substring(0, MAX_OUTPUT)}\n... (truncated)` : text;
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function shouldDenyToolCall(name: string, toolArgs: Record<string, unknown>): string | null {
  return denyOllamaToolCall(name, toolArgs, capabilityProfile, toolMode);
}

function executeTool(name: string, toolArgs: Record<string, unknown>): string {
  const cwd = process.cwd();

  try {
    switch (name) {
      case 'bash': {
        const cmd = String(toolArgs.command || '');
        const denied = denyOllamaToolCall('bash', { command: cmd }, capabilityProfile, toolMode);
        if (denied) {
          return denied;
        }
        try {
          return truncate(execSync(cmd, {
            cwd,
            timeout: 60_000,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
          }));
        } catch (err) {
          const execErr = err as { stdout?: string; stderr?: string; status?: number };
          const output = [execErr.stdout || '', execErr.stderr || ''].filter(Boolean).join('\n');
          return truncate(output || `Command failed with exit code ${execErr.status ?? 'unknown'}`);
        }
      }
      case 'read_file': {
        const path = resolve(cwd, String(toolArgs.path || ''));
        return truncate(readFileSync(path, 'utf-8'));
      }
      case 'write_file': {
        const denied = denyOllamaToolCall('write_file', toolArgs, capabilityProfile, toolMode);
        if (denied) {
          return denied;
        }
        const path = resolve(cwd, String(toolArgs.path || ''));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(toolArgs.content || ''));
        return `File written: ${path}`;
      }
      case 'edit_file': {
        const denied = denyOllamaToolCall('edit_file', toolArgs, capabilityProfile, toolMode);
        if (denied) {
          return denied;
        }
        const path = resolve(cwd, String(toolArgs.path || ''));
        const content = readFileSync(path, 'utf-8');
        const oldString = String(toolArgs.old_string || '');
        const newString = String(toolArgs.new_string || '');
        if (!content.includes(oldString)) {
          return `Error: old_string not found in ${path}`;
        }
        writeFileSync(path, content.replace(oldString, newString));
        return `File edited: ${path}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function streamChat(): Promise<{ text: string; toolCalls: any[] }> {
  const messages: HistoryMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push(...history);

  const body: Record<string, unknown> = { model, messages, stream: true };
  const toolDefs = buildOllamaToolDefs(toolMode);
  if (toolDefs.length > 0) {
    body.tools = toolDefs;
  }

  const resp = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => resp.statusText);
    if (resp.status === 404) {
      throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama API error ${resp.status}: ${errorText}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullText = '';
  let toolCalls: any[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: any[] } };
        if (chunk.message?.content) {
          fullText += chunk.message.content;
          emit({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: chunk.message.content }],
            },
          });
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      } catch {}
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer) as { message?: { content?: string; tool_calls?: any[] } };
      if (chunk.message?.content) {
        fullText += chunk.message.content;
        emit({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: chunk.message.content }],
          },
        });
      }
      if (chunk.message?.tool_calls?.length) {
        toolCalls = chunk.message.tool_calls;
      }
    } catch {}
  }

  return { text: fullText, toolCalls };
}

async function handleTurn(userText: string): Promise<void> {
  history.push({ role: 'user', content: userText });

  try {
    for (let i = 0; i < 25; i++) {
      const result = await streamChat();
      if (result.toolCalls.length === 0) {
        const finalText = stripThinkTags(result.text);
        history.push({ role: 'assistant', content: finalText });
        saveHistory();
        emit({
          type: 'result',
          result: finalText,
          session_id: sessionId,
          is_error: false,
        });
        return;
      }

      history.push({
        role: 'assistant',
        content: result.text || '',
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const toolName = toolCall.function?.name || 'unknown';
        const rawArgs = toolCall.function?.arguments;
        const parsedArgs = typeof rawArgs === 'string'
          ? JSON.parse(rawArgs)
          : (rawArgs || {});
        const deniedMessage = shouldDenyToolCall(toolName, parsedArgs);
        if (deniedMessage) {
          emit({
            type: 'result',
            result: deniedMessage,
            session_id: sessionId,
            is_error: true,
          });
          return;
        }

        emit({
          type: 'assistant',
          subtype: 'tool_use',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              name: toolName === 'bash' ? 'Bash' : toolName,
              input: parsedArgs,
            }],
          },
        });

        const output = executeTool(toolName, parsedArgs);
        history.push({
          role: 'tool',
          content: output,
          tool_call_id: toolCall.id,
        });

        emit({
          type: 'assistant',
          subtype: 'tool_result',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              name: toolName === 'bash' ? 'Bash' : toolName,
              output,
            }],
          },
        });
      }
    }

    throw new Error('Ollama exceeded the tool iteration limit');
  } catch (err) {
    emit({
      type: 'result',
      result: `Ollama bridge error: ${err instanceof Error ? err.message : String(err)}`,
      session_id: sessionId,
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
