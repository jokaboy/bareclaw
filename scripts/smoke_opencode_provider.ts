import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { ProcessManager } from '../src/core/process-manager.js';

const PROJECT_PATH = '0 Agent Vault/Agents/10_Projects/misc-projects/bareclaw';
const WORKSPACE_ID = 'misc-projects';
const PROJECT_ID = 'bareclaw';
const DEFAULT_MODEL = process.env.BARECLAW_OPENCODE_SMOKE_MODEL?.trim() || undefined;

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

function assertSmokeReply(
  label: string,
  response: { text: string; is_error?: boolean; system_notice?: string },
  token: string,
): void {
  if (response.is_error) {
    throw new Error(`${label} turn failed: ${response.text}`);
  }
  if (!response.text.includes(token)) {
    throw new Error(`${label} turn did not contain expected token "${token}". Received: ${response.text}`);
  }
  if (response.system_notice?.includes('could not start provider "opencode"')) {
    throw new Error(`${label} turn fell back away from opencode: ${response.system_notice}`);
  }
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bareclaw-opencode-smoke-'));
  const channel = `smoke-opencode-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pm = new ProcessManager(buildSmokeConfig(stateDir));

  try {
    (pm as any).channelStateStore.update(channel, {
      providerId: 'opencode',
      ...(DEFAULT_MODEL ? { model: DEFAULT_MODEL } : {}),
      startupMode: 'auto_resume',
      bindingStatus: 'bound',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      activeWorkItemId: 'wi_smoke_opencode_provider_health',
      activeWorkItemTitle: 'OpenCode smoke verification',
      activeWorkItemStatus: 'active',
      workItemSelectionMode: 'explicit',
      runLockStatus: 'active',
      continuitySource: 'none',
      continuitySyncStatus: 'clean',
      resumeSource: 'none',
    });

    const first = await pm.send(channel, 'What is 2+2? Reply with only the digit 4.');
    assertSmokeReply('first', first, '4');

    const second = await pm.send(channel, 'What is 3+4? Reply with only the digit 7.');
    assertSmokeReply('second', second, '7');

    console.log(JSON.stringify({
      ok: true,
      channel,
      provider: 'opencode',
      model: DEFAULT_MODEL || 'provider-default',
      first: first.text,
      second: second.text,
      session_id: pm.getChannelState(channel).rawProviderSessionId,
    }));
  } finally {
    try {
      await pm.resetThread(channel, true);
    } catch {
      // Best-effort cleanup for the scratch smoke channel.
    }
    pm.shutdownHosts();
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[smoke:opencode] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
