/**
 * Provider registry — maps provider IDs to implementations.
 * New providers are registered here.
 */

import type { Provider } from './types.js';
import { ClaudeProvider } from './claude.js';

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

// Register built-in providers
registerProvider(new ClaudeProvider());
