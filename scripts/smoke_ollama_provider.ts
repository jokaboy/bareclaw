import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { ProcessManager } from '../src/core/process-manager.js';

const PROJECT_PATH = '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw';
const WORKSPACE_ID = 'misc-projects';
const PROJECT_ID = 'bareclaw';
const DEFAULT_MODEL = process.env.BARECLAW_OLLAMA_SMOKE_MODEL || 'qwen3.5:9b';

function buildSmokeConfig(stateDir: string): Config {
  const base = loadConfig();
  return {
    ...base,
    cwd: resolve(import.meta.dirname, '..'),
    supervised: false,
    telegramToken: undefined,
    httpToken: undefined,
    allowedUsers: [],
    continuityBridgeScript: undefined,
    continuityPythonBinary: undefined,
    bootstrapPromptFile: undefined,
    warmChannels: [],
    sessionFile: join(stateDir, 'smoke-sessions.json'),
    channelStateFile: join(stateDir, 'smoke-channel-state.json'),
  };
}

function assertSmokeReply(label: string, response: { text: string; is_error?: boolean; system_notice?: string }, token: string): void {
  if (response.is_error) {
    throw new Error(`${label} turn failed: ${response.text}`);
  }
  if (!response.text.includes(token)) {
    throw new Error(`${label} turn did not contain expected token "${token}". Received: ${response.text}`);
  }
  if (response.system_notice?.includes('could not start provider "ollama"')) {
    throw new Error(`${label} turn fell back away from ollama: ${response.system_notice}`);
  }
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bareclaw-ollama-smoke-'));
  const channel = `smoke-ollama-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pm = new ProcessManager(buildSmokeConfig(stateDir));
  let sessionId: string | undefined;

  try {
    (pm as any).channelStateStore.update(channel, {
      providerId: 'ollama',
      model: DEFAULT_MODEL,
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      activeWorkItemId: 'wi_smoke_ollama_provider_health',
      activeWorkItemTitle: 'Ollama smoke verification',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      runLockStatus: 'active',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      resumeSource: 'none',
    });

    const firstToken = 'BARECLAW_OLLAMA_SMOKE_OK';
    const secondToken = 'BARECLAW_OLLAMA_SMOKE_SECOND_OK';

    const first = await pm.send(channel, `Reply with exactly ${firstToken} and nothing else.`);
    assertSmokeReply('first', first, firstToken);

    const second = await pm.send(channel, `Reply with exactly ${secondToken} and nothing else.`);
    assertSmokeReply('second', second, secondToken);

    sessionId = pm.getChannelState(channel).rawProviderSessionId;
    console.log(JSON.stringify({
      ok: true,
      channel,
      provider: 'ollama',
      model: DEFAULT_MODEL,
      first: first.text,
      second: second.text,
      session_id: sessionId,
    }));
  } finally {
    sessionId = sessionId || pm.getChannelState(channel).rawProviderSessionId;
    try {
      await pm.resetThread(channel, true);
    } catch {}
    pm.shutdownHosts();
    if (sessionId) {
      await rm(`/tmp/bareclaw-ollama-${sessionId}.json`, { force: true }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[smoke:ollama] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
