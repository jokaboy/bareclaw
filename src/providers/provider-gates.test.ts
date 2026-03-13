import { describe, expect, it } from 'vitest';
import { buildOllamaToolDefs, denyCodexEvent, denyOllamaToolCall } from './provider-gates.js';

describe('denyCodexEvent', () => {
  it('fails closed on write-capable MCP calls for planning-only threads', () => {
    const denied = denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'obsidian_vault',
        tool: 'agents_write_handoff',
      },
    }, 'planning_only', 'read_only');

    expect(denied).toContain('capability_profile: planning_only');
    expect(denied).toContain('attempted_action: mcp__obsidian_vault__agents_write_handoff');
  });

  it('allows read-only MCP calls for planning-only threads', () => {
    expect(denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'obsidian_vault',
        tool: 'read_note',
      },
    }, 'planning_only', 'read_only')).toBeNull();
  });

  it('handles MCP server names with underscores without misclassifying read-only tools', () => {
    expect(denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'obsidian_agents_writer',
        tool: 'read_note',
      },
    }, 'planning_only', 'read_only')).toBeNull();

    const denied = denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'obsidian_agents_writer',
        tool: 'agents_write_handoff',
      },
    }, 'planning_only', 'read_only');

    expect(denied).toContain('attempted_action: mcp__obsidian_agents_writer__agents_write_handoff');
    expect(denied).toContain('capability_profile: planning_only');
  });

  it('blocks shell execution entirely for unbound threads', () => {
    const denied = denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'command_execution',
      },
    }, 'unbound', 'none');

    expect(denied).toContain('capability_profile: unbound_blocked');
    expect(denied).toContain('attempted_action: Bash');
  });

  it('blocks post-hoc file changes for run-lock-blocked threads', () => {
    const denied = denyCodexEvent({
      type: 'item.completed',
      item: {
        type: 'file_change',
      },
    }, 'run_lock_blocked', 'read_only');

    expect(denied).toContain('capability_profile: run_lock_blocked');
    expect(denied).toContain('attempted_action: Edit');
  });

  it('permits provider events when execution is ready', () => {
    expect(denyCodexEvent({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'obsidian_vault',
        tool: 'agents_write_handoff',
      },
    }, 'execution_ready', 'full')).toBeNull();
  });
});

describe('buildOllamaToolDefs', () => {
  it('exposes no tools for unbound threads', () => {
    expect(buildOllamaToolDefs('none')).toEqual([]);
  });

  it('exposes only read-only tools for intake/planning threads', () => {
    const tools = buildOllamaToolDefs('read_only');
    const names = tools.map((tool) => String((tool.function as { name?: string }).name));

    expect(names).toEqual(['bash', 'read_file']);
  });

  it('exposes write tools only for execution-ready threads', () => {
    const tools = buildOllamaToolDefs('full');
    const names = tools.map((tool) => String((tool.function as { name?: string }).name));

    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
  });
});

describe('denyOllamaToolCall', () => {
  it('blocks write tool calls for intake capture threads', () => {
    const denied = denyOllamaToolCall('write_file', { path: 'notes.md', content: 'x' }, 'intake_capture', 'read_only');

    expect(denied).toContain('capability_profile: intake_capture');
    expect(denied).toContain('write_state: read_only');
  });

  it('blocks unsafe shell commands for planning-only threads', () => {
    const denied = denyOllamaToolCall('bash', { command: 'echo hi > out.txt' }, 'planning_only', 'read_only');

    expect(denied).toContain('capability_profile: planning_only');
    expect(denied).toContain('attempted_action: Bash');
  });

  it('permits safe read-only shell commands for planning-only threads', () => {
    expect(denyOllamaToolCall('bash', { command: 'rg capability src' }, 'planning_only', 'read_only')).toBeNull();
  });

  it('permits write tools when execution is ready', () => {
    expect(denyOllamaToolCall('write_file', { path: 'notes.md', content: 'x' }, 'execution_ready', 'full')).toBeNull();
  });
});
