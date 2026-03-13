export interface OllamaProbeOptions {
  host?: string;
  model?: string;
  defaultModel?: string;
}

export interface OllamaModelTag {
  name?: string;
}

export interface OllamaTagsResponse {
  models?: OllamaModelTag[];
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b';

export function resolveOllamaHost(host?: string): string {
  const resolved = (host || process.env.BARECLAW_OLLAMA_HOST || DEFAULT_OLLAMA_HOST).trim();
  return resolved.replace(/\/+$/, '');
}

export function resolveOllamaModel(options: Pick<OllamaProbeOptions, 'model' | 'defaultModel'> = {}): string {
  return (
    options.model
    || process.env.BARECLAW_OLLAMA_MODEL
    || options.defaultModel
    || DEFAULT_OLLAMA_MODEL
  ).trim();
}

export async function fetchOllamaModels(host = resolveOllamaHost()): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${host}/api/tags`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Ollama host unreachable at ${host}: ${reason}`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Ollama tags probe failed at ${host}: ${response.status} ${errorText}`.trim());
  }

  let payload: OllamaTagsResponse;
  try {
    payload = await response.json() as OllamaTagsResponse;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Ollama tags probe returned invalid JSON at ${host}: ${reason}`);
  }

  return (payload.models || [])
    .map((model) => model.name?.trim())
    .filter((name): name is string => Boolean(name));
}

export async function probeOllamaAvailability(options: OllamaProbeOptions = {}): Promise<string | null> {
  const host = resolveOllamaHost(options.host);
  const model = resolveOllamaModel(options);
  const models = await fetchOllamaModels(host);

  if (!models.includes(model)) {
    const available = models.length > 0 ? models.join(', ') : 'none';
    return `Ollama model "${model}" is not available at ${host}. Available: ${available}. Run: ollama pull ${model}`;
  }

  return null;
}
