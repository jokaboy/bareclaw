import {
  formatCapabilityDeniedMessage,
  isReadOnlyBashCommand,
  isWriteCapableToolName,
  type CapabilityProfile,
  type ProviderToolMode,
} from './capability.js';

export interface CodexEventLike {
  type: string;
  item?: {
    type?: string;
    server?: string;
    tool?: string;
  };
}

export function denyCodexEvent(
  event: CodexEventLike,
  capabilityProfile: CapabilityProfile,
  toolMode: ProviderToolMode,
): string | null {
  if (toolMode === 'full') return null;

  if (event.type === 'item.started') {
    const item = event.item;
    if (toolMode === 'none' && item?.type === 'command_execution') {
      return formatCapabilityDeniedMessage('Codex', 'Bash', capabilityProfile);
    }
    if (item?.type === 'mcp_tool_call') {
      const toolName = `mcp__${item.server}__${item.tool}`;
      if (isWriteCapableToolName(toolName)) {
        return formatCapabilityDeniedMessage('Codex', toolName, capabilityProfile);
      }
    }
  }

  if (event.type === 'item.completed' && event.item?.type === 'file_change') {
    return formatCapabilityDeniedMessage('Codex', 'Edit', capabilityProfile);
  }

  return null;
}

export function buildOllamaToolDefs(toolMode: ProviderToolMode): Array<Record<string, unknown>> {
  if (toolMode === 'none') return [];

  const readOnlyDefs: Array<Record<string, unknown>> = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: toolMode === 'read_only'
          ? 'Run a strictly read-only shell command such as rg, ls, cat, git status, or git diff.'
          : 'Run a shell command and return its output.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read and return the contents of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
  ];

  if (toolMode !== 'full') return readOnlyDefs;

  return [
    ...readOnlyDefs,
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file with content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace one exact string in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
  ];
}

export function denyOllamaToolCall(
  name: string,
  toolArgs: Record<string, unknown>,
  capabilityProfile: CapabilityProfile,
  toolMode: ProviderToolMode,
): string | null {
  if (toolMode === 'full') return null;
  if (name === 'write_file' || name === 'edit_file') {
    return formatCapabilityDeniedMessage('Ollama', name, capabilityProfile);
  }
  if (name === 'bash') {
    const command = String(toolArgs.command || '');
    if (toolMode === 'none') return formatCapabilityDeniedMessage('Ollama', 'Bash', capabilityProfile);
    if (!isReadOnlyBashCommand(command)) {
      return formatCapabilityDeniedMessage('Ollama', 'Bash', capabilityProfile);
    }
  }
  return null;
}
