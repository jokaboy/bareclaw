/**
 * Provider registry — maps provider IDs to implementations.
 * New providers are registered here.
 */

import type { Provider } from './types.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { OllamaProvider } from './ollama.js';

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) {
    const available = [...providers.keys()].join(', ');
    throw new Error(`Unknown provider: "${id}". Available: ${available}`);
  }
  return provider;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

export function listProviderEntries(): Provider[] {
  return [...providers.values()];
}

// Register built-in providers
registerProvider(new ClaudeProvider());
registerProvider(new CodexProvider());
registerProvider(new OllamaProvider());
