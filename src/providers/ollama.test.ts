import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OLLAMA_HOST,
  fetchOllamaModels,
  probeOllamaAvailability,
  resolveOllamaHost,
} from './ollama-health.js';

describe('ollama health helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BARECLAW_OLLAMA_HOST;
    delete process.env.BARECLAW_OLLAMA_MODEL;
  });

  it('normalizes the Ollama host and trims trailing slashes', () => {
    process.env.BARECLAW_OLLAMA_HOST = 'http://localhost:11434///';
    expect(resolveOllamaHost()).toBe(DEFAULT_OLLAMA_HOST);
    expect(resolveOllamaHost('http://example.test///')).toBe('http://example.test');
  });

  it('returns null when the requested model is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3:4b' },
          { name: 'gpt-oss:20b' },
        ],
      }),
    })));

    await expect(probeOllamaAvailability({ model: 'qwen3:4b' })).resolves.toBeNull();
  });

  it('reports a clear pull command when the requested model is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'gemma3:4b' },
        ],
      }),
    })));

    await expect(probeOllamaAvailability({ model: 'qwen3:4b' })).resolves.toContain('Run: ollama pull qwen3:4b');
  });

  it('surfaces host-unreachable failures with the target host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }));

    await expect(fetchOllamaModels()).rejects.toThrow('Ollama host unreachable at http://localhost:11434');
  });

  it('surfaces invalid JSON errors from the tags probe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    })));

    await expect(fetchOllamaModels()).rejects.toThrow('Ollama tags probe returned invalid JSON');
  });
});
