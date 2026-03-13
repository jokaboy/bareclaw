import { describe, expect, it } from 'vitest';
import { buildBridgeRequestPayload } from './canonical-continuity.js';

describe('buildBridgeRequestPayload', () => {
  it('generates a run_id when the payload omits one', () => {
    const request = buildBridgeRequestPayload({
      channel_id: 'tg--1003847112401-3',
      workspace_id: 'shared',
      project_id: 'easy-tts-podcasts',
      project_path: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      provider_id: 'codex',
      startup_mode: 'fresh_with_handoff',
    });

    expect(request.run_id).toMatch(/^bareclaw-continuity-easy-tts-podcasts-tg-1003847112401-3-/);
    expect(request.channel_id).toBe('tg--1003847112401-3');
    expect(request.project_path).toBe('0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts');
  });

  it('preserves an explicit run_id', () => {
    const request = buildBridgeRequestPayload({
      run_id: 'shared-easy-tts-podcasts-20260307T082500Z',
      channel_id: 'tg--1003847112401-3',
      workspace_id: 'shared',
      project_id: 'easy-tts-podcasts',
      project_path: '0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts',
      provider_id: 'codex',
      startup_mode: 'fresh_with_handoff',
    });

    expect(request.run_id).toBe('shared-easy-tts-podcasts-20260307T082500Z');
  });
});
