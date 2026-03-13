/**
 * Telegram adapter — reference implementation for BAREclaw adapters.
 *
 * Channel key: `tg-<chatId>` or `tg-<chatId>-<threadId>` for forum topics.
 *
 * UX design: minimize noise, maximize signal.
 * - One live "status" message updates in-place with tool activity
 * - Edits/Writes get their own messages with collapsible diffs
 * - Questions (AskUserQuestion) get their own messages
 * - Final result sent as the actual response
 * - Short filler text ("Let me check that") is suppressed
 */
import { Telegraf, Input } from 'telegraf';
import type { Context } from 'telegraf';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import type { ProcessManager, MessageContent } from '../core/process-manager.js';
import {
  type CapabilityGuidance,
  isStructuredCapabilityGuidance,
  parseCapabilityGuidance,
} from '../core/capability-guidance.js';
import { describeCapabilitySurface } from '../providers/capability.js';
import {
  type ChannelState,
  NON_SYSTEM_INTAKE_PROJECT_PATH,
  isExecutionEligibleWorkItemStatus,
  resolveWorkItemMode,
  SYSTEM_INTAKE_PROJECT_PATH,
  type StartupMode,
} from '../core/channel-state.js';
import type { ChannelContext, ClaudeEvent, ContentBlock, PushHandler, PushMedia, SendMessageResponse } from '../core/types.js';

export { isStructuredCapabilityGuidance, parseCapabilityGuidance } from '../core/capability-guidance.js';

const MAX_MESSAGE_LENGTH = 4096;
const FILLER_MAX_LENGTH = 100;
const HELP_PATTERNS = [
  /^(help|what can i say|show help)$/i,
  /\bwhat (can|should) i (say|do)\b/i,
  /\bhow do i start\b/i,
  /\bshow (the )?state\b/i,
  /\bwhat state (is|am) (this|we)\b/i,
];
const GREETING_PATTERN = /^(hi|hello|hey|yo|howdy|good morning|good afternoon|good evening)[!. ]*$/i;
const PLAN_PATTERNS = [
  /\bstart planning\b/i,
  /\bwrite (me )?(a |the )?plan\b/i,
  /\bmake (me )?(a |the )?plan\b/i,
  /\bplan this\b/i,
  /\bplan the work\b/i,
];
const WORKITEM_PATTERNS = [
  /\bmake (?:the |a )?(?:new )?work item\b/i,
  /\bcreate (?:the |a )?(?:new )?work item\b/i,
  /\bbind (the )?work item\b/i,
];
const EXECUTION_START_PATTERNS = [
  /\bget to work\b/i,
  /\bstart work\b/i,
  /\bbegin work\b/i,
  /\bget started\b/i,
  /\bstart implementation\b/i,
  /\bbegin implementation\b/i,
];
const NEW_WORKITEM_PATTERNS = [
  /\bnew work item\b/i,
  /\bfresh work item\b/i,
  /\bdifferent scope\b/i,
  /\bcreate another work item\b/i,
  /\bcreate a new work item\b/i,
];
const APPROVE_PATTERNS = [/^approve(?: it)?$/i, /^yes, approve(?: it)?$/i];
const DENY_PATTERNS = [/^deny(?: it)?$/i, /^reject(?: it)?$/i];
const PROMOTE_PATTERNS = [
  /\bpromote (this|the) project\b/i,
  /\bmove this out of intake\b/i,
  /\bactivate this project\b/i,
];
const BIND_EXISTING_PATTERNS = [/^bind existing$/i, /^use existing$/i, /^keep existing$/i];
const CREATE_NEW_PATTERNS = [/^create new$/i, /^make new$/i, /^new one$/i, /^create a new work item$/i];
const BOOTSTRAP_PROGRESS_PATTERNS = [
  /\back\b/i,
  /\bbootstrap\b/i,
  /\bpreflight\b/i,
  /\bpreflight_context\b/i,
  /\bgovernance\b/i,
  /\bcontinuity state\b/i,
  /\brequired ack\b/i,
  /\bcanonical bootstrap\b/i,
];

interface HelpEntry {
  syntax: string;
  purpose: string;
  good: string[];
  bad?: string[];
  note?: string;
}

interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Everyday',
    entries: [
      {
        syntax: '/status',
        purpose: 'Show the current provider, binding, work-item, continuity, and queue state for this thread.',
        good: ['/status'],
        note: 'No arguments are required; extra words are ignored.',
      },
      {
        syntax: '/help',
        purpose: 'Show the full grouped command reference for this thread.',
        good: ['/help'],
        note: 'No arguments are required; extra words are ignored.',
      },
      {
        syntax: '/plan [title]',
        purpose: 'Write the current plan in chat and save the resulting draft artifact.',
        good: ['/plan', '/plan Fix Telegram help output'],
        note: 'The title is optional. If omitted, BareClaw derives one from the current thread.',
      },
      {
        syntax: '/new',
        purpose: 'Force the next turn to start fresh in this same lane while keeping the current binding.',
        good: ['/new'],
        note: 'No arguments are required; extra words are ignored.',
      },
    ],
  },
  {
    title: 'Project and Approval',
    entries: [
      {
        syntax: '/project',
        purpose: 'Show the current project binding and quick binding options.',
        good: ['/project'],
        note: 'Use the exact forms below to change the binding.',
      },
      {
        syntax: '/project <vault project path>',
        purpose: 'Bind this thread to a specific active project path.',
        good: ['/project 0 Agent Vault/Agents/10_Projects/shared/easy-tts-podcasts'],
        note: 'Use the full vault path when binding directly to a project lane.',
      },
      {
        syntax: '/project ideas',
        purpose: 'Bind this thread to the shared ideas lane.',
        good: ['/project ideas'],
        note: 'Aliases: /project default, /project intake, /project intake-non-system, /project intake-shared.',
      },
      {
        syntax: '/project ideas-system',
        purpose: 'Bind this thread to the system ideas lane.',
        good: ['/project ideas-system'],
        note: 'Aliases: /project default-system, /project intake-system, /project system-intake.',
      },
      {
        syntax: '/project bootstrap <project_id|workspace/project|vault project path>',
        purpose: 'Create a brand-new active project lane and bind this thread to it.',
        good: ['/project bootstrap easy-tts-podcasts', '/project bootstrap shared/easy-tts-podcasts'],
        bad: ['/project bootstrap'],
      },
      {
        syntax: '/project promote [project_id]',
        purpose: 'Promote the current intake thread into an active project lane.',
        good: ['/project promote', '/project promote easy-tts-podcasts'],
        note: 'The project id is optional when the current intake lane already implies the target.',
      },
      {
        syntax: '/project clear',
        purpose: 'Clear the current project binding so the next ordinary message starts from the default ideas lane.',
        good: ['/project clear'],
        bad: ['/project clear now'],
      },
      {
        syntax: '/artifact draft <title>',
        purpose: 'Save the latest planning response as a canonical draft artifact.',
        good: ['/artifact draft Telegram help rewrite'],
        bad: ['/artifact draft'],
      },
      {
        syntax: '/approval list [status]',
        purpose: 'List approval requests for the current project lane.',
        good: ['/approval list', '/approval list pending'],
        note: 'The status filter is optional.',
      },
      {
        syntax: '/approval request <work_item_title>',
        purpose: 'Queue an execution approval request tied to the current planning context.',
        good: ['/approval request Implement Telegram help reference'],
        bad: ['/approval request'],
      },
      {
        syntax: '/approval approve <request_id> [note]',
        purpose: 'Approve a pending request and unlock the next governance step.',
        good: ['/approval approve req-123', '/approval approve req-123 looks good'],
        bad: ['/approval approve'],
      },
      {
        syntax: '/approval deny <request_id> [note]',
        purpose: 'Deny a pending request while leaving the thread in planning-only mode.',
        good: ['/approval deny req-123', '/approval deny req-123 missing acceptance criteria'],
        bad: ['/approval deny'],
      },
    ],
  },
  {
    title: 'Work Items',
    entries: [
      {
        syntax: '/workitem auto',
        purpose: 'Bind the latest work item BareClaw can safely infer for this project.',
        good: ['/workitem auto'],
        bad: ['/workitem auto now'],
      },
      {
        syntax: '/workitem <work_item_id>',
        purpose: 'Bind this thread to one specific work item id.',
        good: ['/workitem wi_20260311_telegram_help'],
        note: 'Use the canonical work item id exactly as stored in the control plane.',
      },
      {
        syntax: '/workitem create <title>',
        purpose: 'Create a proposed work item and bind this thread to it.',
        good: ['/workitem create Implement Telegram help reference'],
        bad: ['/workitem create'],
      },
      {
        syntax: '/workitem start',
        purpose: 'Promote the currently bound proposed work item to active.',
        good: ['/workitem start'],
        bad: ['/workitem start now'],
      },
      {
        syntax: '/workitem verify <v0|v1|v2> <pass|fail> [best_artifact_ref|failure_mode]',
        purpose: 'Record verifier evidence for the active work item.',
        good: ['/workitem verify v1 pass docs/help-screenshot', '/workitem verify v2 fail missing-live-check'],
        bad: ['/workitem verify v3 pass', '/workitem verify v1 maybe'],
      },
      {
        syntax: '/workitem settle <done|blocked|timeout|killed> [best_artifact_ref|failure_mode]',
        purpose: 'Settle the active work item with its final outcome.',
        good: ['/workitem settle done docs/help-reference', '/workitem settle blocked waiting-on-live-telegram'],
        bad: ['/workitem settle shipped', '/workitem settle'],
      },
      {
        syntax: '/workitem clear',
        purpose: 'Clear the current work-item binding and drop back to planning-only mode.',
        good: ['/workitem clear'],
        bad: ['/workitem clear now'],
      },
    ],
  },
  {
    title: 'Advanced / Operator',
    entries: [
      {
        syntax: '/provider [list|claude|codex|ollama|opencode]',
        purpose: 'List providers or switch the provider for this thread.',
        good: ['/provider list', '/provider codex', '/provider opencode'],
        bad: ['/provider banana'],
      },
      {
        syntax: '/model [list|default|<model>]',
        purpose: 'List available models or set a specific model on the current provider.',
        good: ['/model list', '/model default', '/model gpt-5.3-codex'],
        note: 'Model names are provider-specific. Use /model list when the provider exposes a known list.',
      },
      {
        syntax: '/mode [list|auto_resume|fresh_with_handoff|warm_lcm_restore|raw_provider_resume]',
        purpose: 'Override the startup strategy for this thread.',
        good: ['/mode list', '/mode auto_resume'],
        bad: ['/mode banana'],
      },
      {
        syntax: '/handoff',
        purpose: 'Show the current manual handoff and automatic handoff state.',
        good: ['/handoff'],
        note: 'Use the exact forms below to set or clear a manual handoff override.',
      },
      {
        syntax: '/handoff <summary>',
        purpose: 'Store a manual handoff summary for the next fresh start.',
        good: ['/handoff Pick up from the Telegram help implementation and run live validation next.'],
        note: 'Any non-empty text becomes the stored handoff summary.',
      },
      {
        syntax: '/handoff clear',
        purpose: 'Clear the stored manual handoff override.',
        good: ['/handoff clear'],
        bad: ['/handoff clear now'],
      },
      {
        syntax: '/checkpoint [refresh]',
        purpose: 'Show the latest automatic checkpoint or regenerate it first.',
        good: ['/checkpoint', '/checkpoint refresh'],
        note: 'Any argument other than refresh is treated like /checkpoint.',
      },
      {
        syntax: '/reset',
        purpose: 'Clear the raw provider session while keeping stored continuity.',
        good: ['/reset'],
        note: 'Use /reset full when you also want to clear stored project continuity.',
      },
      {
        syntax: '/reset full',
        purpose: 'Clear both the raw provider session and the stored project continuity.',
        good: ['/reset full', '/reset --full'],
        note: 'Any other /reset arguments still perform the soft reset.',
      },
    ],
  },
];

export interface TelegramCommand {
  name: string;
  args: string[];
  argText: string;
}

/** Escape special HTML characters */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown to Telegram-compatible HTML.
 *
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, and headers. Everything else passes through as escaped text.
 */
export function markdownToHtml(md: string): string {
  // Extract fenced code blocks first to protect them from inline processing
  const codeBlocks: string[] = [];
  const withPlaceholders = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    codeBlocks.push(lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Process each line (for headers) then inline formatting
  const lines = withPlaceholders.split('\n');
  const processed = lines.map(line => {
    // Check for code block placeholder — pass through untouched
    if (line.match(/^\x00CODEBLOCK\d+\x00$/)) return line;

    // Headers → bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      return `<b>${convertInline(headerMatch[2])}</b>`;
    }

    return convertInline(line);
  });

  let result = processed.join('\n');

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return result;
}

/** Convert inline markdown (bold, italic, code, links, strikethrough) */
function convertInline(text: string): string {
  // Extract inline code first to protect from other processing
  const inlineCode: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape HTML in remaining text
  s = escapeHtml(s);

  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words for _)
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    s = s.replace(`\x00INLINE${i}\x00`, inlineCode[i]);
  }

  return s;
}

/** Split text into chunks that fit Telegram's message limit */
export function splitText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    parts.push(text.substring(i, i + MAX_MESSAGE_LENGTH));
  }
  return parts;
}

export function telegramChannel(chatId: number, threadId?: number): string {
  return threadId ? `tg-${chatId}-${threadId}` : `tg-${chatId}`;
}

export function parseTelegramChannel(channel: string): { chatId: number; threadId?: number } | null {
  const match = channel.match(/^tg-(-?\d+)(?:-(\d+))?$/);
  if (!match) return null;

  const chatId = Number(match[1]);
  const threadId = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(chatId)) return null;
  if (threadId !== undefined && !Number.isSafeInteger(threadId)) return null;

  return threadId === undefined ? { chatId } : { chatId, threadId };
}

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z_]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const argText = (match[2] || '').trim();
  return {
    name: match[1]!.toLowerCase(),
    args: argText ? argText.split(/\s+/) : [],
    argText,
  };
}

export function formatProjectCommandStatus(
  state: Pick<
    ChannelState,
    | 'bindingStatus'
    | 'projectPath'
    | 'workspaceId'
    | 'projectId'
    | 'pendingApprovalRequestId'
    | 'pendingApprovalScope'
    | 'pendingApprovalStatus'
  >
): string {
  return [
    'project_binding_changed: no',
    'note: /project with no argument only shows the current binding. Use one of the commands below to change it.',
    `binding_status: ${state.bindingStatus}`,
    `project_path: ${state.projectPath || 'none'}`,
    `workspace_id: ${state.workspaceId || 'none'}`,
    `project_id: ${state.projectId || 'none'}`,
    `pending_approval_request_id: ${state.pendingApprovalRequestId || 'none'}`,
    `pending_approval_scope: ${state.pendingApprovalScope || 'none'}`,
    `pending_approval_status: ${state.pendingApprovalStatus || 'none'}`,
    'quick_options:',
    '- /project ideas',
    '- /project ideas-system',
    '- /project bootstrap <project_id|workspace_id/project_id>',
    '- /project promote [project_id]',
    '- /artifact draft <title>',
    '- /approval request <work_item_title>',
    '- /project clear',
    '- /project <vault project path>',
    `ideas_path: ${NON_SYSTEM_INTAKE_PROJECT_PATH}`,
    `ideas_system_path: ${SYSTEM_INTAKE_PROJECT_PATH}`,
  ].join('\n');
}

function buildProjectLookupHint(
  state: Pick<ChannelState, 'bindingStatus' | 'projectPath' | 'workspaceId' | 'projectId'>
): string {
  if (state.bindingStatus !== 'bound' || !state.projectId) return '';
  if (state.workspaceId && state.workspaceId === state.projectId) {
    return `BareClaw will use project_id "${state.projectId}" for work-item lookup. ` +
      'This looks like a workspace/root lane, so bind a leaf project path before execution if you mean a child project.';
  }
  return `BareClaw will use project_id "${state.projectId}" for work-item lookup.`;
}

function hasPlanningDraft(state: Pick<ChannelState, 'lastAssistantResponse' | 'lastDraftArtifactPath'>): boolean {
  return Boolean(state.lastAssistantResponse?.trim() || state.lastDraftArtifactPath);
}

function isWriteEnabled(state: ChannelState): boolean {
  const capability = describeCapabilitySurface(resolveWorkItemMode(state), {
    workItemSelectionMode: state.workItemSelectionMode,
    activeWorkItemStatus: state.activeWorkItemStatus,
    blockingRunId: state.runLockBlockingRunId,
    blockingAgentThread: state.runLockBlockingAgentThread,
    pendingApprovalRequestId: state.pendingApprovalRequestId,
    pendingApprovalScope: state.pendingApprovalScope,
  });
  return capability.writeState === 'enabled';
}

export function buildThreadStateChecklist(state: ChannelState): string[] {
  return [
    `project bound: ${state.projectPath ? 'yes' : 'no'}`,
    `work item bound: ${state.activeWorkItemId ? 'yes' : 'no'}`,
    `planning draft exists: ${hasPlanningDraft(state) ? 'yes' : 'no'}`,
    `write mode: ${isWriteEnabled(state) ? 'yes' : 'no'}`,
  ];
}

function nextPlainEnglishStep(state: ChannelState): string {
  if (!state.projectPath) {
    return 'Say "start planning" to open the default ideas lane, or use /project bootstrap <workspace>/<project> for a specific project.';
  }
  if (state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending') {
    return `Say "approve it" to continue, "deny it" to reject it, or use /approval approve ${state.pendingApprovalRequestId}.`;
  }
  if (state.bindingStatus === 'intake') {
    return 'Planning works here. When you are ready to execute, promote or bootstrap the project first.';
  }
  if (!hasPlanningDraft(state)) {
    return 'Say "start planning" or use /plan to have BareClaw write and save the plan first.';
  }
  if (!state.activeWorkItemId) {
    return 'Say "make the work item" to create or bind one, or say "get to work" and BareClaw will route it for you.';
  }
  if (!isWriteEnabled(state)) {
    return 'Use /help to see the thread state and the next valid action.';
  }
  return 'Say "get to work" to continue execution in this thread.';
}

export function buildBlockedActionReply(state: ChannelState, guidance?: CapabilityGuidance | null): string {
  const lead = state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending'
    ? 'I understand what you want, but this chat is waiting on approval before it can keep going.'
    : 'I understand what you want, but this chat cannot start write-capable work right now.';

  return [
    lead,
    '',
    ...buildThreadStateChecklist(state),
    '',
    `reason: ${guidance?.reason || 'This thread is not in a write-capable state yet.'}`,
    `next: ${nextPlainEnglishStep(state)}`,
    'help: /help',
  ].join('\n');
}

function isBootstrapSensitiveText(text: string): boolean {
  const normalized = text.trim();
  return BOOTSTRAP_PROGRESS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildTerminalBlockedActionReply(
  state: ChannelState,
  guidance: CapabilityGuidance | null | undefined,
  options: { streamed: boolean; bootstrapSensitive: boolean },
): string {
  if (!options.streamed) {
    return buildBlockedActionReply(state, guidance);
  }

  const lead = options.bootstrapSensitive
    ? 'Earlier progress messages in this turn were provisional. The ACK/bootstrap did not complete.'
    : 'Earlier progress messages in this turn were provisional. This turn ended blocked.';
  const next = options.bootstrapSensitive
    ? 'Wait for the ACK/bootstrap to complete, or retry the same request. Do not send a new task yet.'
    : nextPlainEnglishStep(state);

  return [
    lead,
    '',
    ...buildThreadStateChecklist(state),
    '',
    `reason: ${guidance?.reason || 'This thread is not in a write-capable state yet.'}`,
    `next: ${next}`,
    'help: /help',
  ].join('\n');
}

function shouldSendStartupIntro(state: ChannelState): boolean {
  return !state.projectPath
    && !state.lastAssistantResponse
    && !state.lastDraftArtifactPath
    && !state.pendingApprovalRequestId
    && !state.rawProviderSessionId;
}

function formatHelpEntry(entry: HelpEntry): string {
  const lines = [
    entry.syntax,
    `what: ${entry.purpose}`,
    ...entry.good.map((example) => `good: ${example}`),
  ];
  if (entry.bad?.length) {
    lines.push(...entry.bad.map((example) => `bad: ${example}`));
  }
  if (entry.note) {
    lines.push(`note: ${entry.note}`);
  }
  return lines.join('\n');
}

export function buildThreadHelpMessages(state: ChannelState): string[] {
  const header = [
    'BareClaw Telegram help',
    '',
    ...buildThreadStateChecklist(state),
    '',
    'Same topic resumes automatically. Use /new to start fresh in this same lane.',
    'Plain English still works for common actions, but the commands below are the exact supported forms.',
  ].join('\n');
  const sections = HELP_SECTIONS.map((section) => [
    section.title,
    '',
    ...section.entries.map((entry) => formatHelpEntry(entry)),
  ].join('\n\n'));
  return [header, ...sections];
}

export function buildThreadHelpMessage(state: ChannelState): string {
  const lines = [
    'BareClaw Telegram quick start',
    '',
    ...buildThreadStateChecklist(state),
    '',
    'Same topic resumes automatically. Use /new to start fresh in this same lane.',
    '',
    'Try one of these:',
    '- "start planning" to have BareClaw write and save the plan',
    '- "make the work item" to create or bind the next work item',
    '- "get to work" to start execution when the thread is ready',
  ];

  if (state.bindingStatus === 'intake') {
    lines.push('- "promote this project" to move this intake thread into an active project lane');
  } else if (!state.projectPath) {
    lines.push('- /project bootstrap <workspace>/<project> to start a brand new active project');
  }

  lines.push('- /help to show this again');
  return lines.join('\n');
}

function isHelpRequest(text: string): boolean {
  return HELP_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isGreetingMessage(text: string): boolean {
  return GREETING_PATTERN.test(text.trim());
}

function isPlanningRequest(text: string): boolean {
  return PLAN_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isExplicitExecutionStartRequest(text: string): boolean {
  return EXECUTION_START_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isWorkItemRequest(text: string): boolean {
  return WORKITEM_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isNewWorkItemRequest(text: string): boolean {
  return NEW_WORKITEM_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isApprovalReply(text: string, decision: 'approve' | 'deny'): boolean {
  const patterns = decision === 'approve' ? APPROVE_PATTERNS : DENY_PATTERNS;
  return patterns.some((pattern) => pattern.test(text.trim()));
}

function isPromotionRequest(text: string): boolean {
  return PROMOTE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isPendingWorkItemReply(text: string, choice: 'bind_existing' | 'create_new'): boolean {
  const patterns = choice === 'bind_existing' ? BIND_EXISTING_PATTERNS : CREATE_NEW_PATTERNS;
  return patterns.some((pattern) => pattern.test(text.trim()));
}

function isCompoundWorkItemExecutionRequest(text: string): boolean {
  const normalized = text.trim();
  if (!isWorkItemRequest(normalized)) return false;
  return /(?:\band\b|\bthen\b|,)/i.test(normalized)
    && /\b(start|get started|get to work|begin|execute|run|implementation)\b/i.test(normalized);
}

function buildFallbackCapabilityGuidance(state: ChannelState, message: string): CapabilityGuidance | null {
  const normalized = message.trim();
  if (!normalized) return null;

  if (
    normalized.startsWith('This thread is bound to an intake lane.')
    || normalized.startsWith('This thread is still in intake mode.')
    || normalized.startsWith('No active work item is available for ')
    || normalized.startsWith('The explicitly bound work item ')
    || normalized === 'No execution-ready work item is currently bound for this thread.'
    || normalized === 'The previously bound work item is no longer execution-ready.'
  ) {
    return {
      reason: normalized,
      capability_profile: resolveWorkItemMode(state),
    };
  }

  return null;
}

/** Send a message as HTML, falling back to plain text */
async function sendHtml(ctx: Context, html: string): Promise<void> {
  for (const chunk of splitText(html)) {
    await ctx.reply(chunk, { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(chunk.replace(/<[^>]*>/g, ''))
    );
  }
}

// Internal tools — never shown in the status line
export const HIDDEN_TOOLS = new Set([
  'EnterPlanMode', 'ExitPlanMode', 'Task', 'TaskCreate',
  'TaskUpdate', 'TaskList', 'TaskGet',
  'TodoWrite', 'TodoRead', 'WebSearch', 'WebFetch',
  'ToolSearch', 'NotebookEdit', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'Skill',
]);

/** Format an Edit tool call as a collapsible diff */
export function formatDiff(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const old = escapeHtml(String(input.old_string || ''));
  const new_ = escapeHtml(String(input.new_string || ''));
  const diffLines: string[] = [];
  for (const line of old.split('\n')) diffLines.push('- ' + line);
  for (const line of new_.split('\n')) diffLines.push('+ ' + line);
  return `<code>Edit: ${file}</code>\n<blockquote expandable><pre>${diffLines.join('\n')}</pre></blockquote>`;
}

/** Format a Write tool call as a collapsible preview */
export function formatWrite(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const content = escapeHtml(String(input.content || ''));
  const preview = content.length > 1000 ? content.substring(0, 1000) + '...' : content;
  return `<code>Write: ${file}</code>\n<blockquote expandable><pre>${preview}</pre></blockquote>`;
}

/** Format an AskUserQuestion tool call */
export function formatQuestion(input: Record<string, unknown>): string {
  const questions = input.questions as Array<Record<string, unknown>> | undefined;
  if (!questions?.length) return '<code>AskUserQuestion</code>';
  const parts: string[] = [];
  for (const q of questions) {
    parts.push(`<b>${escapeHtml(String(q.question || ''))}</b>`);
    const options = q.options as Array<Record<string, unknown>> | undefined;
    if (options?.length) {
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const label = escapeHtml(String(opt.label || ''));
        const desc = opt.description ? ` — ${escapeHtml(String(opt.description))}` : '';
        parts.push(`  ${i + 1}. ${label}${desc}`);
      }
    }
  }
  return parts.join('\n');
}

/** Check if text is short filler ("Let me read that.", "I'll check this.") */
export function isFiller(text: string): boolean {
  return text.length < FILLER_MAX_LENGTH && !text.includes('\n') && !text.includes('```');
}

/**
 * Tracks tool activity for a single turn and manages an in-place status message.
 */
class StatusLine {
  private ctx: Context;
  private messageId: number | null = null;
  private tools: string[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Add a tool to the status line and update the message */
  addTool(name: string, target?: string) {
    const label = target ? `${name}: ${target}` : name;
    this.tools.push(label);
    this.pending = this.pending.then(() => this.update()).catch(() => {});
  }

  /** Wait for all pending updates to flush */
  async flush() {
    await this.pending;
  }

  /** Reset the status line so the next tool creates a fresh message */
  reset() {
    this.pending = this.pending.then(() => {});
    this.messageId = null;
    this.tools = [];
  }

  private async update() {
    const text = this.tools.map(t => `<code>${escapeHtml(t)}</code>`).join('\n');
    if (text.length === 0) return;

    try {
      if (this.messageId) {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat!.id, this.messageId, undefined, text,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else {
        const msg = await this.ctx.reply(text, { parse_mode: 'HTML' });
        this.messageId = msg.message_id;
      }
    } catch {}
  }
}

const MEDIA_DIR = join(homedir(), '.bareclaw', 'media');
const MAX_FILE_SIZE = 20 * 1024 * 1024; // Telegram bot API limit is 20MB

/** Map file extensions to MIME types for common Telegram media */
export function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.tgs': 'application/x-tgsticker', '.webm': 'video/webm',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

/** Get file extension from a URL or filename */
export function extFromUrl(url: string): string {
  const match = url.match(/\.(\w+)(?:\?|$)/);
  return match ? `.${match[1]}` : '';
}

interface DownloadedFile {
  path: string;
  buffer: Buffer;
  ext: string;
  mime: string;
}

/**
 * Download a Telegram file to ~/.bareclaw/media/<channel>/.
 * Returns the local path, buffer, extension, and MIME type.
 */
export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  channel: string,
  opts?: { fileName?: string; ext?: string }
): Promise<DownloadedFile> {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const url = fileLink.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  const ext = opts?.ext || extFromUrl(url) || '.bin';
  const mime = mimeFromExt(ext);
  const timestamp = Date.now();
  const safeName = opts?.fileName
    ? opts.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    : `file${ext}`;
  const fileName = `${timestamp}-${safeName}`;

  const dir = join(MEDIA_DIR, channel);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, buffer);

  return { path: filePath, buffer, ext, mime };
}

/** Map a MIME type to the Telegram send method type */
export function inferMediaType(mime: string): PushMedia['type'] {
  if (mime === 'image/gif') return 'animation';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'audio/ogg') return 'voice';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/x-tgsticker') return 'sticker';
  return 'document';
}

export interface TextDebouncer {
  add(channel: string, text: string, ctx: Context): void;
  flush(channel: string): void;
}

/**
 * Batches rapid text messages on the same channel (e.g. Telegram paste-chunks)
 * and flushes them as a single combined message after `delayMs` of silence.
 */
export function createTextDebouncer(
  delayMs: number,
  onFlush: (channel: string, combinedText: string, ctx: Context) => void,
): TextDebouncer {
  const pending = new Map<string, { texts: string[]; ctx: Context; timer: ReturnType<typeof setTimeout> }>();

  function flush(channel: string) {
    const entry = pending.get(channel);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(channel);
    const combined = entry.texts.join('\n\n');
    if (entry.texts.length > 1) {
      console.log(`[telegram] debounced ${entry.texts.length} text messages on ${channel}`);
    }
    onFlush(channel, combined, entry.ctx);
  }

  function add(channel: string, text: string, ctx: Context) {
    const existing = pending.get(channel);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(text);
      existing.ctx = ctx;
      existing.timer = setTimeout(() => flush(channel), delayMs);
    } else {
      const timer = setTimeout(() => flush(channel), delayMs);
      pending.set(channel, { texts: [text], ctx, timer });
    }
  }

  return { add, flush };
}

export function createTelegramAdapter(config: Config, processManager: ProcessManager): { bot: Telegraf; pushHandler: PushHandler } {
  if (config.allowedUsers.length === 0) {
    throw new Error(
      'BARECLAW_ALLOWED_USERS is required when Telegram is enabled. ' +
      'BAREclaw has shell access — an open bot is an open door to your machine.'
    );
  }

  const bot = new Telegraf(config.telegramToken!, {
    handlerTimeout: Infinity,
  });

  bot.catch((err) => {
    console.error(`[telegram] unhandled error: ${err instanceof Error ? err.message : err}`);
  });

  function channelFor(ctx: Context): string {
    const msg = ctx.message as Record<string, unknown> | undefined;
    const threadId = msg?.message_thread_id as number | undefined;
    return telegramChannel(ctx.chat!.id, threadId);
  }

  async function replyPre(ctx: Context, text: string): Promise<void> {
    await sendHtml(ctx, `<pre>${escapeHtml(text)}</pre>`);
  }

  async function replyThreadHelp(ctx: Context, state: ChannelState): Promise<void> {
    for (const message of buildThreadHelpMessages(state)) {
      await replyPre(ctx, message);
    }
  }

  function buildChannelContext(ctx: Context, channel: string): ChannelContext {
    const msg = ctx.message as Record<string, unknown> | undefined;
    const threadId = msg?.message_thread_id as number | undefined;
    return {
      channel,
      adapter: 'telegram',
      userName: ctx.from ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') : undefined,
      chatTitle: ctx.chat!.type !== 'private' ? (ctx.chat as { title?: string }).title : undefined,
      topicName: threadId ? String(threadId) : undefined,
    };
  }

  interface TurnEnvelope {
    response: SendMessageResponse;
    artifactPath?: string;
  }

  async function runTurn(
    ctx: Context,
    logLabel: string,
    request: (channel: string, context: ChannelContext, onEvent: (event: ClaudeEvent) => void) => Promise<TurnEnvelope>,
  ): Promise<TurnEnvelope | null> {
    const userId = ctx.from!.id;

    if (!config.allowedUsers.includes(userId)) {
      console.log(`[telegram] blocked message from user ${userId}`);
      return null;
    }

    console.log(`[telegram] <- user ${userId}: ${logLabel}`);

    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);

    const channel = channelFor(ctx);
    const context = buildChannelContext(ctx, channel);

    try {
      let sendChain = Promise.resolve();
      let compacting = false;
      let sentStreamed = false;
      let bootstrapSensitiveProgress = false;
      const status = new StatusLine(ctx);

      const envelope = await request(channel, context, (event: ClaudeEvent) => {
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          compacting = true;
          return;
        }
        if (compacting) {
          if (event.type === 'assistant') {
            compacting = false;
          } else {
            return;
          }
        }
        if (event.type !== 'assistant' || !event.message?.content) return;

        for (const block of event.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            const bootstrapSensitiveBlock = isBootstrapSensitiveText(block.text);
            if (!isFiller(block.text) || bootstrapSensitiveBlock) {
              sentStreamed = true;
              bootstrapSensitiveProgress = bootstrapSensitiveProgress || bootstrapSensitiveBlock;
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, markdownToHtml(
                  bootstrapSensitiveBlock ? `Progress: ${block.text!}` : block.text!
                )))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            }
          } else if (block.type === 'tool_use' && block.name && !HIDDEN_TOOLS.has(block.name)) {
            const input = block.input as Record<string, unknown> | undefined;

            if (block.name === 'Edit' && input) {
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatDiff(input)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else if (block.name === 'Write' && input) {
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatWrite(input)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else if (block.name === 'AskUserQuestion' && input) {
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatQuestion(input)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else {
              const target = input?.file_path || input?.path || input?.pattern || input?.command;
              status.addTool(block.name, target ? String(target) : undefined);
            }
          }
        }
      });

      const response = envelope.response;
      await sendChain;
      await status.flush();
      clearInterval(typingInterval);

      if (response.coalesced) return envelope;

      console.log(`[telegram] -> user ${userId}: ${response.duration_ms}ms`);

      if (response.system_notice?.trim()) {
        await replyPre(ctx, response.system_notice.trim()).catch(() => {});
      }

      if (response.is_error && response.text.trim()) {
        const guidance = response.capabilityGuidance || parseCapabilityGuidance(response.text);
        if (guidance) {
          const state = processManager.getChannelState(channel);
          await replyPre(ctx, buildTerminalBlockedActionReply(state, guidance, {
            streamed: sentStreamed,
            bootstrapSensitive: bootstrapSensitiveProgress,
          }));
        }
        return envelope;
      }

      if (!sentStreamed && !compacting && !response.is_error && response.text.trim()) {
        await sendHtml(ctx, markdownToHtml(response.text));
      }

      return envelope;
    } catch (err) {
      clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[telegram] error: ${message}`);

      const state = processManager.getChannelState(channel);
      const guidance = parseCapabilityGuidance(message) || buildFallbackCapabilityGuidance(state, message);
      if (guidance) {
        await replyPre(ctx, buildBlockedActionReply(state, guidance)).catch(() => {});
        return null;
      }
      if (message === 'No plan exists yet. Ask BareClaw to write one first.') {
        await ctx.reply('No plan exists yet. Ask BareClaw to write one first. Try "start planning" or /plan.').catch(() => {});
        return null;
      }

      await ctx.reply(`Error: ${message}`).catch(() => {});
      return null;
    }
  }

  async function runPlanningFlow(ctx: Context, requestText: string, title?: string): Promise<TurnEnvelope | null> {
    const envelope = await runTurn(
      ctx,
      `plan: ${requestText.substring(0, 80)}${requestText.length > 80 ? '...' : ''}`,
      async (channel, context, onEvent) => {
        const result = await processManager.planChannelWork(channel, requestText, context, {
          title,
          onEvent,
        });
        return {
          response: result.response,
          artifactPath: result.path,
        };
      },
    );

    if (envelope?.artifactPath) {
      await ctx.reply(`Plan saved: ${envelope.artifactPath}`).catch(() => {});
    }

    return envelope;
  }

  async function replyTurnError(ctx: Context, channel: string, message: string): Promise<void> {
    const state = processManager.getChannelState(channel);
    const guidance = parseCapabilityGuidance(message) || buildFallbackCapabilityGuidance(state, message);
    if (guidance) {
      await replyPre(ctx, buildBlockedActionReply(state, guidance)).catch(() => {});
      return;
    }
    if (message === 'No plan exists yet. Ask BareClaw to write one first.') {
      await ctx.reply('No plan exists yet. Ask BareClaw to write one first. Try "start planning" or /plan.').catch(() => {});
      return;
    }
    await ctx.reply(`Error: ${message}`).catch(() => {});
  }

  async function handleCommand(ctx: Context, command: TelegramCommand): Promise<boolean> {
    const userId = ctx.from!.id;
    if (!config.allowedUsers.includes(userId)) {
      console.log(`[telegram] blocked command from user ${userId}`);
      return true;
    }

    const channel = channelFor(ctx);

    try {
      switch (command.name) {
        case 'status': {
          await replyPre(ctx, processManager.describeChannel(channel));
          return true;
        }

        case 'help': {
          await replyThreadHelp(ctx, processManager.getChannelState(channel));
          return true;
        }

        case 'plan': {
          const title = command.argText.trim() || undefined;
          const state = processManager.getChannelState(channel);
          const requestText = title
            ? `Write the current project plan and save it under the title "${title}".`
            : `Write the current project plan for ${state.projectId || 'this thread'} and save it.`;
          await runPlanningFlow(ctx, requestText, title);
          return true;
        }

        case 'provider': {
          if (command.args.length === 0 || command.args[0] === 'list') {
            const current = processManager.getChannelState(channel);
            const providers = await processManager.getAvailableProviderStatuses(channel);
            const lines = [
              `current_provider: ${current.providerId}`,
              `current_model: ${current.model || 'provider-default'}`,
              'available_providers:',
              ...providers.map((provider) => {
                const details = [
                  provider.defaultModel ? `default: ${provider.defaultModel}` : undefined,
                  provider.checkedModel ? `checked: ${provider.checkedModel}` : undefined,
                  `status: ${provider.status}`,
                  provider.reason ? `reason: ${provider.reason}` : undefined,
                ].filter(Boolean);
                return `- ${provider.id}${details.length ? ` (${details.join('; ')})` : ''}`;
              }),
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          const next = await processManager.setChannelProvider(channel, command.args[0]!);
          const providerInfo = processManager.getAvailableProviders().find((provider) => provider.id === next.providerId);
          await ctx.reply(
            `Provider set to ${next.providerId}` +
            `${providerInfo?.defaultModel ? ` (default model: ${providerInfo.defaultModel})` : ''}. ` +
            'The raw provider session was reset; project continuity was preserved.'
          );
          return true;
        }

        case 'mode': {
          if (command.args.length === 0 || command.args[0] === 'list') {
            const state = processManager.getChannelState(channel);
            const lines = [
              `current_mode: ${state.startupMode}`,
              'available_modes:',
              '- auto_resume',
              '- fresh_with_handoff',
              '- warm_lcm_restore',
              '- raw_provider_resume',
              'auto_resume: reconnect the live session first, then try a saved raw session, then fall back to continuity.',
              'warm_lcm_restore: restore/init LCM when available, otherwise fall back to canonical handoff, checkpoint, and project memory.',
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          const next = await processManager.setChannelStartupMode(channel, command.args[0] as StartupMode);
          const message = next.startupMode === 'auto_resume'
            ? 'Startup mode set to auto_resume. BareClaw will reconnect the live session when possible, then try any saved raw session, then fall back to continuity.'
            : next.startupMode === 'raw_provider_resume'
            ? 'Startup mode set to raw_provider_resume. BareClaw will try to reuse any saved raw provider session on the next spawn.'
            : next.startupMode === 'warm_lcm_restore'
              ? 'Startup mode set to warm_lcm_restore. BareClaw will restore/init LCM when available, then fall back to canonical project continuity if needed.'
              : 'Startup mode set to fresh_with_handoff. BareClaw will ignore saved raw provider sessions and inject stored continuity on fresh starts.';
          await ctx.reply(message);
          return true;
        }

        case 'model': {
          const state = processManager.getChannelState(channel);
          const providerInfo = processManager.getAvailableProviders().find((provider) => provider.id === state.providerId);
          if (command.args.length === 0 || command.args[0] === 'list') {
            const lines = [
              `provider: ${state.providerId}`,
              `current_model: ${state.model || providerInfo?.defaultModel || 'provider-default'}`,
            ];
            if (providerInfo?.availableModels?.length) {
              lines.push(`available_models: ${providerInfo.availableModels.join(', ')}`);
            } else {
              lines.push('available_models: provider-default only');
            }
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          const rawModel = command.argText;
          const normalized = /^(default|clear|reset)$/i.test(rawModel) ? undefined : rawModel;
          const next = await processManager.setChannelModel(channel, normalized);
          await ctx.reply(
            normalized
              ? `Model set to ${next.model} on ${next.providerId}. The raw provider session was reset.`
              : `Model cleared for ${next.providerId}; BareClaw will use the provider default on the next fresh turn.`
          );
          return true;
        }

        case 'handoff': {
          if (!command.argText) {
            const state = processManager.getChannelState(channel);
            const lines = [
              `last_handoff_ref: ${state.lastHandoffRef || 'none'}`,
              `manual_handoff: ${state.handoffSummary || 'none'}`,
              `auto_handoff: ${state.autoHandoffSummary || 'none'}`,
              'usage: /handoff <summary> or /handoff clear',
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          if (command.argText.toLowerCase() === 'clear') {
            processManager.clearChannelHandoff(channel);
            await ctx.reply('Stored handoff cleared. Existing live sessions keep their current context until the next fresh start or `/reset`.');
            return true;
          }

          processManager.setChannelHandoff(channel, command.argText);
          await ctx.reply('Stored handoff updated. It will be injected on the next fresh start or after `/reset`.');
          return true;
        }

        case 'checkpoint': {
          if (command.argText.toLowerCase() === 'refresh') {
            const checkpoint = processManager.refreshChannelCheckpoint(channel);
            if (!checkpoint.summary) {
              await ctx.reply('No automatic checkpoint is stored for this thread yet.');
              return true;
            }
            const lines = [
              `checkpoint_updated_at: ${checkpoint.updatedAt || 'unknown'}`,
              checkpoint.summary,
            ];
            await replyPre(ctx, lines.join('\n\n'));
            return true;
          }

          const checkpoint = processManager.getChannelCheckpoint(channel);
          if (!checkpoint.summary) {
            await ctx.reply('No automatic checkpoint is stored for this thread yet.');
            return true;
          }
          const lines = [
            `checkpoint_updated_at: ${checkpoint.updatedAt || 'unknown'}`,
            checkpoint.summary,
          ];
          await replyPre(ctx, lines.join('\n\n'));
          return true;
        }

        case 'artifact': {
          if (!command.argText) {
            const state = processManager.getChannelState(channel);
            const lines = [
              `binding_status: ${state.bindingStatus}`,
              `project_path: ${state.projectPath || 'none'}`,
              `last_assistant_response: ${state.lastAssistantResponse ? 'set' : 'none'}`,
              `last_draft_artifact_path: ${state.lastDraftArtifactPath || 'none'}`,
              `pending_approval_request_id: ${state.pendingApprovalRequestId || 'none'}`,
              'usage: /artifact draft <title>',
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'draft') {
            const title = command.args.slice(1).join(' ').trim();
            if (!title) {
              throw new Error('Usage: /artifact draft <title>');
            }
            const result = await processManager.writeChannelArtifactDraft(channel, title);
            await ctx.reply(
              `Artifact draft written: ${result.path || 'unknown path'}. ` +
              'The thread stays planning-only until you request and approve execution.'
            );
            return true;
          }

          throw new Error('Usage: /artifact draft <title>');
        }

        case 'approval': {
          if (!command.argText) {
            const state = processManager.getChannelState(channel);
            const lines = [
              `project_path: ${state.projectPath || 'none'}`,
              `last_draft_artifact_path: ${state.lastDraftArtifactPath || 'none'}`,
              `last_approval_request_id: ${state.lastApprovalRequestId || 'none'}`,
              `pending_approval_request_id: ${state.pendingApprovalRequestId || 'none'}`,
              `pending_approval_scope: ${state.pendingApprovalScope || 'none'}`,
              `pending_approval_status: ${state.pendingApprovalStatus || 'none'}`,
              'usage: /approval list [status] | /approval request <work_item_title> | /approval approve <request_id> [note] | /approval deny <request_id> [note]',
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'list') {
            const status = command.args.slice(1).join(' ').trim() || undefined;
            const requests = await processManager.listChannelApprovalRequests(channel, status);
            if (requests.length === 0) {
              await ctx.reply('No approval requests found for the current filter.');
              return true;
            }
            const lines = requests.map((request) => [
              `request_id: ${request.request_id || 'unknown'}`,
              `status: ${request.status || 'unknown'}`,
              `scope: ${request.scope || 'unknown'}`,
              `workspace_id: ${request.workspace_id || 'none'}`,
              `project_id: ${request.project_id || 'none'}`,
              `created_at: ${request.created_at || 'unknown'}`,
              request.decided_at ? `decided_at: ${request.decided_at}` : undefined,
            ].filter(Boolean).join(' | '));
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'request') {
            const title = command.args.slice(1).join(' ').trim();
            if (!title) {
              throw new Error('Usage: /approval request <work_item_title>');
            }
            const { request } = await processManager.queueChannelExecutionApproval(channel, title);
            await ctx.reply(
              `Approval requested: ${request.request_id || 'unknown'} for ${title}. ` +
              'Use /approval approve <request_id> to unlock execution or /approval deny <request_id> [note] to reject it.'
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'approve') {
            const requestId = command.args[1]?.trim();
            if (!requestId) {
              throw new Error('Usage: /approval approve <request_id> [note]');
            }
            const note = command.args.slice(2).join(' ').trim() || undefined;
            const result = await processManager.decideChannelApprovalRequest(channel, requestId, 'approve', note);
            const capability = describeCapabilitySurface(resolveWorkItemMode(result.state), {
              workItemSelectionMode: result.state.workItemSelectionMode,
              activeWorkItemStatus: result.state.activeWorkItemStatus,
              blockingRunId: result.state.runLockBlockingRunId,
              blockingAgentThread: result.state.runLockBlockingAgentThread,
              pendingApprovalRequestId: result.state.pendingApprovalRequestId,
              pendingApprovalScope: result.state.pendingApprovalScope,
            });
            if (result.request?.scope === 'intake_project_promote') {
              await ctx.reply(
                `Approval granted: ${result.request.request_id || requestId}. ` +
                `Project lane active: ${result.state.projectPath || 'unknown'}. ` +
                `Capability profile: ${capability.capabilityProfile}. ` +
                'The thread remains planning-only until you ask BareClaw to start execution.'
              );
              return true;
            }

            const label = result.state.activeWorkItemTitle
              ? `${result.state.activeWorkItemTitle} [${result.state.activeWorkItemId}]`
              : (result.state.activeWorkItemId || 'none');
            await ctx.reply(
              `Approval granted: ${result.request?.request_id || requestId}. ` +
              `Work item ready: ${label}` +
              `${result.state.activeWorkItemStatus ? ` (${result.state.activeWorkItemStatus})` : ''}. ` +
              `Capability profile: ${capability.capabilityProfile}. ` +
              'The raw provider session was reset so the next ordinary message can begin work.'
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'deny') {
            const requestId = command.args[1]?.trim();
            if (!requestId) {
              throw new Error('Usage: /approval deny <request_id> [note]');
            }
            const note = command.args.slice(2).join(' ').trim() || undefined;
            const result = await processManager.decideChannelApprovalRequest(channel, requestId, 'deny', note);
            await ctx.reply(
              `Approval denied: ${result.request?.request_id || requestId}. ` +
              'The thread remains planning-only.'
            );
            return true;
          }

          throw new Error(
            'Usage: /approval list [status] | /approval request <work_item_title> | /approval approve <request_id> [note] | /approval deny <request_id> [note]'
          );
        }

        case 'project': {
          if (!command.argText) {
            const state = processManager.getChannelState(channel);
            console.log(
              `[telegram] /project status channel=${channel} binding=${state.bindingStatus} ` +
              `project=${state.projectPath || 'none'}`
            );
            await replyPre(ctx, formatProjectCommandStatus(state));
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'bootstrap') {
            const targetSpec = command.args.slice(1).join(' ').trim();
            if (!targetSpec) {
              throw new Error('Usage: /project bootstrap <project_id|workspace_id/project_id|vault project path>');
            }
            const next = await processManager.bootstrapChannelProject(channel, targetSpec);
            const capability = describeCapabilitySurface(resolveWorkItemMode(next), {
              workItemSelectionMode: next.workItemSelectionMode,
              activeWorkItemStatus: next.activeWorkItemStatus,
              blockingRunId: next.runLockBlockingRunId,
              blockingAgentThread: next.runLockBlockingAgentThread,
              pendingApprovalRequestId: next.pendingApprovalRequestId,
              pendingApprovalScope: next.pendingApprovalScope,
            });
            await ctx.reply(
              `Project bootstrapped: ${next.projectPath}. ` +
              `Capability profile: ${capability.capabilityProfile}. ` +
              'The thread stays planning-only until you draft the plan and approve execution in chat. ' +
              'Suggested next steps: ask BareClaw to write the plan, then run /artifact draft <title> and /approval request <work_item_title>.'
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'promote') {
            const previous = processManager.getChannelState(channel);
            const requestedProjectId = command.args.slice(1).join(' ').trim() || undefined;
            const next = await processManager.promoteChannelProject(channel, requestedProjectId);
            const capability = describeCapabilitySurface(resolveWorkItemMode(next), {
              workItemSelectionMode: next.workItemSelectionMode,
              activeWorkItemStatus: next.activeWorkItemStatus,
              blockingRunId: next.runLockBlockingRunId,
              blockingAgentThread: next.runLockBlockingAgentThread,
              pendingApprovalRequestId: next.pendingApprovalRequestId,
              pendingApprovalScope: next.pendingApprovalScope,
            });
            if (next.pendingApprovalRequestId && next.pendingApprovalScope === 'intake_project_promote') {
              await ctx.reply(
                `Promotion approval requested: ${next.pendingApprovalRequestId}. ` +
                `Target project lane: ${next.pendingApprovalTargetProjectPath || 'unknown'}. ` +
                `Capability profile: ${capability.capabilityProfile}. ` +
                `Approve with /approval approve ${next.pendingApprovalRequestId} or deny with /approval deny ${next.pendingApprovalRequestId} [note].`
              );
              return true;
            }

            await ctx.reply(
              `Project promoted from intake: ${previous.projectPath || 'none'} -> ${next.projectPath}. ` +
              `Capability profile: ${capability.capabilityProfile}. ` +
              'The thread stays planning-only until you draft the plan and approve execution in chat. ' +
              'Suggested next steps: ask BareClaw to write the plan, then run /artifact draft <title> and /approval request <work_item_title>.'
            );
            return true;
          }

          if (command.argText.toLowerCase() === 'clear') {
            console.log(`[telegram] /project clear channel=${channel}`);
            await processManager.resetThread(channel, true);
            await ctx.reply(
              'Project binding cleared. The next normal message will auto-start in the default ideas lane unless you choose another project first.'
            );
            return true;
          }

          const normalized = command.argText.toLowerCase();
          const targetPath = normalized === 'ideas'
            || normalized === 'default'
            || normalized === 'intake'
            || normalized === 'intake-non-system'
            || normalized === 'intake-shared'
            ? NON_SYSTEM_INTAKE_PROJECT_PATH
            : normalized === 'ideas-system'
              || normalized === 'default-system'
              || normalized === 'intake-system'
              || normalized === 'system-intake'
              ? SYSTEM_INTAKE_PROJECT_PATH
              : command.argText;
          console.log(`[telegram] /project set channel=${channel} target=${targetPath}`);
          const next = await processManager.setChannelProjectPath(channel, targetPath);
          const lookupHint = targetPath === command.argText
            ? ` ${buildProjectLookupHint(next)}`
            : '';
          await ctx.reply(
            `Project binding set: ${next.projectPath}. ` +
            `Binding status: ${next.bindingStatus}. The thread will start from this project's continuity on the next turn.${lookupHint}`
          );
          return true;
        }

        case 'workitem': {
          if (!command.argText) {
            const state = processManager.getChannelState(channel);
            const workItemMode = resolveWorkItemMode(state);
            const capability = describeCapabilitySurface(workItemMode, {
              workItemSelectionMode: state.workItemSelectionMode,
              activeWorkItemStatus: state.activeWorkItemStatus,
              blockingRunId: state.runLockBlockingRunId,
              blockingAgentThread: state.runLockBlockingAgentThread,
              pendingApprovalRequestId: state.pendingApprovalRequestId,
              pendingApprovalScope: state.pendingApprovalScope,
            });
            const lines = [
              `binding_status: ${state.bindingStatus}`,
              `project_path: ${state.projectPath || 'none'}`,
              `work_item_mode: ${workItemMode}`,
              `capability_profile: ${capability.capabilityProfile}`,
              `tool_mode: ${capability.toolMode}`,
              `write_state: ${capability.writeState}`,
              `work_item_selection_mode: ${state.workItemSelectionMode}`,
              `work_item_resolution_source: ${state.workItemResolutionSource || 'none'}`,
              `work_item_resolution_detail: ${state.workItemResolutionDetail || 'none'}`,
              `active_work_item_id: ${state.activeWorkItemId || 'none'}`,
              `active_work_item_title: ${state.activeWorkItemTitle || 'none'}`,
              `active_work_item_status: ${state.activeWorkItemStatus || 'none'}`,
              `run_lock_status: ${state.runLockStatus || 'none'}`,
              `run_lock_blocking_run_id: ${state.runLockBlockingRunId || 'none'}`,
              `run_lock_blocking_agent_thread: ${state.runLockBlockingAgentThread || 'none'}`,
              `write_reason: ${capability.reason}`,
              `write_remediation: ${capability.remediation}`,
              'usage: /workitem auto | /workitem create <title> | /workitem <work_item_id> | /workitem start | /workitem verify <v0|v1|v2> <pass|fail> [ref|failure_mode] | /workitem settle <done|blocked|timeout|killed> [ref|failure_mode] | /workitem clear',
            ];
            await replyPre(ctx, lines.join('\n'));
            return true;
          }

          const normalized = command.argText.trim().toLowerCase();
          if (normalized === 'clear') {
            const next = await processManager.clearChannelWorkItem(channel);
            const capability = describeCapabilitySurface(resolveWorkItemMode(next), {
              workItemSelectionMode: next.workItemSelectionMode,
              activeWorkItemStatus: next.activeWorkItemStatus,
              blockingRunId: next.runLockBlockingRunId,
              blockingAgentThread: next.runLockBlockingAgentThread,
              pendingApprovalRequestId: next.pendingApprovalRequestId,
              pendingApprovalScope: next.pendingApprovalScope,
            });
            await ctx.reply(
              `Work item binding cleared. Capability profile: ${capability.capabilityProfile}. ` +
              `Write state: ${capability.writeState}. ${capability.remediation}`
            );
            return true;
          }

          if (normalized === 'start') {
            const next = await processManager.startChannelWorkItem(channel);
            await ctx.reply(
              `Work item started: ${next.activeWorkItemTitle || next.activeWorkItemId || 'unknown'} ` +
              `[${next.activeWorkItemId || 'none'}] (${next.activeWorkItemStatus || 'unknown'}).`
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'create') {
            const title = command.args.slice(1).join(' ').trim();
            if (!title) {
              throw new Error('Usage: /workitem create <title>');
            }
            const next = await processManager.createChannelWorkItem(channel, title);
            const capability = describeCapabilitySurface(resolveWorkItemMode(next), {
              workItemSelectionMode: next.workItemSelectionMode,
              activeWorkItemStatus: next.activeWorkItemStatus,
              blockingRunId: next.runLockBlockingRunId,
              blockingAgentThread: next.runLockBlockingAgentThread,
              pendingApprovalRequestId: next.pendingApprovalRequestId,
              pendingApprovalScope: next.pendingApprovalScope,
            });
            const label = next.activeWorkItemTitle
              ? `${next.activeWorkItemTitle} [${next.activeWorkItemId}]`
              : (next.activeWorkItemId || 'none');
            const action = next.workItemResolutionSource === 'auto_created'
              ? 'Work item created'
              : 'Work item ready';
            await ctx.reply(
              `${action}: ${label}` +
              `${next.activeWorkItemStatus ? ` (${next.activeWorkItemStatus})` : ''}. ` +
              `Capability profile: ${capability.capabilityProfile}. ` +
              `Write state: ${capability.writeState}. ` +
              'The raw provider session was reset so the next turn starts from this work-item binding.'
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'verify') {
            const tier = command.args[1]?.toLowerCase();
            const verifierStatus = command.args[2]?.toLowerCase();
            if (!tier || !verifierStatus || !['v0', 'v1', 'v2'].includes(tier) || !['pass', 'fail'].includes(verifierStatus)) {
              throw new Error('Usage: /workitem verify <v0|v1|v2> <pass|fail> [best_artifact_ref|failure_mode]');
            }
            const trailing = command.args.slice(3).join(' ').trim() || undefined;
            const next = await processManager.verifyChannelWorkItem(
              channel,
              tier as 'v0' | 'v1' | 'v2',
              verifierStatus as 'pass' | 'fail',
              verifierStatus === 'pass'
                ? { bestSoFarRef: trailing }
                : { failureMode: trailing }
            );
            await ctx.reply(
              `Verifier recorded: ${tier} ${verifierStatus} for ${next.activeWorkItemTitle || next.activeWorkItemId || 'the active work item'}. ` +
              `Status: ${next.activeWorkItemStatus || 'unknown'}.`
            );
            return true;
          }

          if (command.args[0]?.toLowerCase() === 'settle') {
            const targetStatus = command.args[1]?.toLowerCase();
            if (!targetStatus || !['done', 'blocked', 'timeout', 'killed'].includes(targetStatus)) {
              throw new Error('Usage: /workitem settle <done|blocked|timeout|killed> [best_artifact_ref|failure_mode]');
            }
            const trailing = command.args.slice(2).join(' ').trim() || undefined;
            const next = await processManager.settleChannelWorkItem(
              channel,
              targetStatus as 'done' | 'blocked' | 'timeout' | 'killed',
              targetStatus === 'done'
                ? { bestArtifactRef: trailing }
                : { failureMode: trailing }
            );
            await ctx.reply(
              `Work item settled: ${next.activeWorkItemTitle || next.activeWorkItemId || 'the active work item'} ` +
              `[${next.activeWorkItemId || 'none'}] (${next.activeWorkItemStatus || 'unknown'}).`
            );
            return true;
          }

          const next = normalized === 'auto'
            ? await processManager.autoSelectChannelWorkItem(channel)
            : await processManager.setChannelWorkItem(channel, command.argText);
          const capability = describeCapabilitySurface(resolveWorkItemMode(next), {
            workItemSelectionMode: next.workItemSelectionMode,
            activeWorkItemStatus: next.activeWorkItemStatus,
            blockingRunId: next.runLockBlockingRunId,
            blockingAgentThread: next.runLockBlockingAgentThread,
            pendingApprovalRequestId: next.pendingApprovalRequestId,
            pendingApprovalScope: next.pendingApprovalScope,
          });
          const label = next.activeWorkItemTitle
            ? `${next.activeWorkItemTitle} [${next.activeWorkItemId}]`
            : (next.activeWorkItemId || 'none');
          await ctx.reply(
            `Work item bound: ${label}` +
            `${next.activeWorkItemStatus ? ` (${next.activeWorkItemStatus})` : ''}. ` +
            `Capability profile: ${capability.capabilityProfile}. ` +
            `Write state: ${capability.writeState}. ` +
            'The raw provider session was reset so the next turn starts from this work-item binding.'
          );
          return true;
        }

        case 'reset': {
          const full = command.args.includes('--full') || command.args.includes('full');
          await processManager.resetThread(channel, full);
          await ctx.reply(
            full
              ? 'Thread reset. Raw provider session and stored project continuity were cleared; the next ordinary message will auto-start in the default ideas lane unless you choose another project first.'
              : 'Thread reset. Raw provider session was cleared; stored project continuity was preserved.'
          );
          return true;
        }

        case 'new': {
          await processManager.startFreshNextSpawn(channel);
          await ctx.reply('The next turn will start fresh in this same lane. Project and work-item binding were kept.');
          return true;
        }

        default:
          return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown command error';
      console.error(`[telegram] command error: ${message}`);
      await replyTurnError(ctx, channel, message);
      return true;
    }
  }

  async function handleMessage(ctx: Context, content: MessageContent, logLabel: string): Promise<void> {
    await runTurn(
      ctx,
      logLabel,
      async (channel, context, onEvent) => ({
        response: await processManager.send(channel, content, context, onEvent),
      }),
    );
  }

  async function handlePlainEnglishText(ctx: Context, text: string): Promise<boolean> {
    const channel = channelFor(ctx);
    const initialState = processManager.getChannelState(channel);

    if (isHelpRequest(text)) {
      await replyThreadHelp(ctx, initialState);
      return true;
    }

    if (shouldSendStartupIntro(initialState)) {
      await replyPre(ctx, buildThreadHelpMessage(initialState));
      if (isGreetingMessage(text)) {
        return true;
      }
    }

    if (isCompoundWorkItemExecutionRequest(text)) {
      await ctx.reply(
        'I can do that, but I need one step at a time here. Say "make the work item" or "get to work".'
      ).catch(() => {});
      return true;
    }

    let state = processManager.getChannelState(channel);

    if (state.pendingWorkItemChoice === 'bind_existing_or_create_new') {
      if (isPendingWorkItemReply(text, 'bind_existing')) {
        const result = await processManager.resolvePendingWorkItemChoice(channel, 'bind_existing');
        const label = result.state.activeWorkItemTitle
          ? `${result.state.activeWorkItemTitle} [${result.state.activeWorkItemId}]`
          : (result.state.activeWorkItemId || 'unknown');
        await ctx.reply(`Keeping the existing work item: ${label}. Say "get to work" when you want to continue execution.`);
        return true;
      }

      if (isPendingWorkItemReply(text, 'create_new')) {
        try {
          const result = await processManager.resolvePendingWorkItemChoice(channel, 'create_new');
          const label = result.state.activeWorkItemTitle
            ? `${result.state.activeWorkItemTitle} [${result.state.activeWorkItemId}]`
            : (result.state.activeWorkItemId || 'unknown');
          await ctx.reply(`Created a new work item: ${label}. Say "get to work" when you want to continue execution.`);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[telegram] work-item choice error: ${message}`);
          await replyTurnError(ctx, channel, message);
        }
        return true;
      }
    }

    state = processManager.getChannelState(channel);

    if (state.pendingApprovalRequestId && state.pendingApprovalStatus === 'pending') {
      if (isApprovalReply(text, 'approve')) {
        try {
          const result = await processManager.decideChannelApprovalRequest(
            channel,
            state.pendingApprovalRequestId,
            'approve',
          );
          if (result.request?.scope === 'intake_project_promote') {
            await ctx.reply(
              `Approval granted. Project lane active: ${result.state.projectPath || 'unknown'}. ` +
              'Say "start planning" to refresh the plan or "get to work" when you are ready to continue.'
            );
          } else {
            const label = result.state.activeWorkItemTitle
              ? `${result.state.activeWorkItemTitle} [${result.state.activeWorkItemId}]`
              : (result.state.activeWorkItemId || 'unknown');
            await ctx.reply(`Approval granted. Work item ready: ${label}. Say "get to work" to continue execution.`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[telegram] approval error: ${message}`);
          await replyTurnError(ctx, channel, message);
        }
        return true;
      }

      if (isApprovalReply(text, 'deny')) {
        try {
          await processManager.decideChannelApprovalRequest(channel, state.pendingApprovalRequestId, 'deny');
          await ctx.reply('Approval denied. The thread stays planning-only.');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[telegram] approval error: ${message}`);
          await replyTurnError(ctx, channel, message);
        }
        return true;
      }
    }

    state = processManager.getChannelState(channel);

    if (isPromotionRequest(text) && state.bindingStatus === 'intake' && state.projectPath) {
      try {
        const next = await processManager.promoteChannelProject(channel);
        if (next.pendingApprovalRequestId && next.pendingApprovalScope === 'intake_project_promote') {
          await ctx.reply(
            `Promotion approval requested: ${next.pendingApprovalRequestId}. ` +
            `Target project lane: ${next.pendingApprovalTargetProjectPath || 'unknown'}. ` +
            'Reply "approve it" to continue or "deny it" to reject it.'
          );
        } else {
          await ctx.reply(
            `Project promoted: ${next.projectPath || 'unknown'}. ` +
            'Say "start planning" to refresh the plan or "get to work" when you are ready to continue.'
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[telegram] promotion error: ${message}`);
        await replyTurnError(ctx, channel, message);
      }
      return true;
    }

    if (isPlanningRequest(text)) {
      await runPlanningFlow(ctx, text);
      return true;
    }

    if (isWorkItemRequest(text) && !isExplicitExecutionStartRequest(text)) {
      state = processManager.getChannelState(channel);
      const wantsNewWorkItem = isNewWorkItemRequest(text);

      if (wantsNewWorkItem && state.activeWorkItemId && isExecutionEligibleWorkItemStatus(state.activeWorkItemStatus)) {
        try {
          processManager.beginPendingWorkItemChoice(channel, text);
          const label = state.activeWorkItemTitle
            ? `${state.activeWorkItemTitle} [${state.activeWorkItemId}]`
            : state.activeWorkItemId;
          await ctx.reply(
            `An older work item is already bound and may not match this request: ${label || 'unknown'}. ` +
            'Reply "bind existing" to use it, or "create new" to make a new one.'
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[telegram] work-item prompt error: ${message}`);
          await replyTurnError(ctx, channel, message);
        }
        return true;
      }

      try {
        const result = await processManager.ensureChannelWorkItem(channel, {
          forceNew: wantsNewWorkItem,
          requestedTitle: text.trim(),
        });
        const label = result.state.activeWorkItemTitle
          ? `${result.state.activeWorkItemTitle} [${result.state.activeWorkItemId}]`
          : (result.state.activeWorkItemId || 'unknown');
        const prefix = result.action === 'already_bound'
          ? 'Work item already bound'
          : result.action === 'bound_existing'
            ? 'Bound the existing work item'
            : 'Created a new work item';
        await ctx.reply(`${prefix}: ${label}. Say "get to work" when you want to continue execution.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[telegram] work-item error: ${message}`);
        await replyTurnError(ctx, channel, message);
      }
      return true;
    }

    if (isExplicitExecutionStartRequest(text) && !hasPlanningDraft(state)) {
      await runPlanningFlow(ctx, text);
      return false;
    }

    return false;
  }

  const textDebouncer = createTextDebouncer(300, (_channel, combinedText, ctx) => {
    const label = combinedText.substring(0, 80) + (combinedText.length > 80 ? '...' : '');
    handleMessage(ctx, combinedText, label);
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const command = parseTelegramCommand(text);
    if (command && await handleCommand(ctx, command)) {
      return;
    }

    const channel = channelFor(ctx);
    if (await handlePlainEnglishText(ctx, text)) {
      return;
    }
    textDebouncer.add(channel, text, ctx);
  });

  /** Wrap a media handler with auth check + error handling */
  function mediaHandler<T extends Context>(type: string, handler: (ctx: T) => Promise<void>) {
    return async (ctx: T) => {
      if (!config.allowedUsers.includes(ctx.from!.id)) {
        console.log(`[telegram] blocked ${type} from user ${ctx.from!.id}`);
        return;
      }
      try {
        await handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[telegram] ${type} error: ${message}`);
        await ctx.reply(`Error processing ${type}: ${message}`).catch(() => {});
      }
    };
  }

  // --- Photos: base64 for Claude vision + saved to disk ---
  bot.on('photo', mediaHandler('photo', async (ctx) => {
    const channel = channelFor(ctx);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await downloadTelegramFile(ctx, photo.file_id, channel, { ext: '.jpg' });

    const base64Data = file.buffer.toString('base64');
    const mediaType = file.ext === '.png' ? 'image/png'
      : file.ext === '.gif' ? 'image/gif'
      : file.ext === '.webp' ? 'image/webp'
      : 'image/jpeg';

    const caption = ctx.message.caption || 'What do you see in this image?';
    const content: ContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
      { type: 'text', text: `${caption}\n\n(saved to ${file.path})` },
    ];
    await handleMessage(ctx, content, `[photo] ${caption.substring(0, 60)}`);
  }));

  // --- Documents: any file type ---
  bot.on('document', mediaHandler('document', async (ctx) => {
    const channel = channelFor(ctx);
    const doc = ctx.message.document;
    const ext = doc.file_name ? extFromUrl(doc.file_name) || '.bin' : '.bin';
    const file = await downloadTelegramFile(ctx, doc.file_id, channel, {
      fileName: doc.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const isImage = file.mime.startsWith('image/');

    if (isImage) {
      // Render images inline for Claude vision
      const base64Data = file.buffer.toString('base64');
      const content: ContentBlock[] = [
        { type: 'image', source: { type: 'base64', media_type: file.mime, data: base64Data } },
        { type: 'text', text: `${caption || 'Image file received.'}\n\n(saved to ${file.path})` },
      ];
      await handleMessage(ctx, content, `[document:image] ${(doc.file_name || 'image').substring(0, 60)}`);
    } else {
      const sizeKb = (file.buffer.length / 1024).toFixed(1);
      const text = [
        caption,
        `File received: ${doc.file_name || 'unnamed'} (${sizeKb} KB, ${file.mime})`,
        `Saved to: ${file.path}`,
      ].filter(Boolean).join('\n');
      await handleMessage(ctx, text, `[document] ${(doc.file_name || 'file').substring(0, 60)}`);
    }
  }));

  // --- Voice messages ---
  bot.on('voice', mediaHandler('voice', async (ctx) => {
    const channel = channelFor(ctx);
    const voice = ctx.message.voice;
    const file = await downloadTelegramFile(ctx, voice.file_id, channel, { ext: '.ogg' });

    const duration = voice.duration;
    const text = [
      ctx.message.caption || '',
      `Voice message received (${duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[voice] ${duration}s`);
  }));

  // --- Audio files ---
  bot.on('audio', mediaHandler('audio', async (ctx) => {
    const channel = channelFor(ctx);
    const audio = ctx.message.audio;
    const ext = audio.file_name ? extFromUrl(audio.file_name) || '.mp3' : '.mp3';
    const file = await downloadTelegramFile(ctx, audio.file_id, channel, {
      fileName: audio.file_name || undefined,
      ext,
    });

    const parts = [ctx.message.caption || ''];
    if (audio.title) parts.push(`Title: ${audio.title}`);
    if (audio.performer) parts.push(`Artist: ${audio.performer}`);
    parts.push(`Audio file (${audio.duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB, ${file.mime})`);
    parts.push(`Saved to: ${file.path}`);

    await handleMessage(ctx, parts.filter(Boolean).join('\n'), `[audio] ${(audio.title || audio.file_name || 'audio').substring(0, 60)}`);
  }));

  // --- Video files ---
  bot.on('video', mediaHandler('video', async (ctx) => {
    const channel = channelFor(ctx);
    const video = ctx.message.video;
    const ext = video.file_name ? extFromUrl(video.file_name) || '.mp4' : '.mp4';
    const file = await downloadTelegramFile(ctx, video.file_id, channel, {
      fileName: video.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const text = [
      caption,
      `Video received (${video.duration}s, ${video.width}x${video.height}, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[video] ${(video.file_name || 'video').substring(0, 60)}`);
  }));

  // --- Video notes (circular video messages) ---
  bot.on('video_note', mediaHandler('video_note', async (ctx) => {
    const channel = channelFor(ctx);
    const vn = ctx.message.video_note;
    const file = await downloadTelegramFile(ctx, vn.file_id, channel, { ext: '.mp4' });

    const text = [
      `Video note received (${vn.duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].join('\n');
    await handleMessage(ctx, text, `[video_note] ${vn.duration}s`);
  }));

  // --- Stickers ---
  bot.on('sticker', mediaHandler('sticker', async (ctx) => {
    const channel = channelFor(ctx);
    const sticker = ctx.message.sticker;
    const ext = sticker.is_animated ? '.tgs' : sticker.is_video ? '.webm' : '.webp';
    const file = await downloadTelegramFile(ctx, sticker.file_id, channel, { ext });

    const isStaticImage = !sticker.is_animated && !sticker.is_video;
    if (isStaticImage) {
      const base64Data = file.buffer.toString('base64');
      const content: ContentBlock[] = [
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: base64Data } },
        { type: 'text', text: `Sticker: ${sticker.emoji || ''} (set: ${sticker.set_name || 'unknown'})\n\n(saved to ${file.path})` },
      ];
      await handleMessage(ctx, content, `[sticker] ${sticker.emoji || sticker.set_name || 'sticker'}`);
    } else {
      const text = [
        `Sticker received: ${sticker.emoji || ''} (${sticker.is_animated ? 'animated' : 'video'}, set: ${sticker.set_name || 'unknown'})`,
        `Saved to: ${file.path}`,
      ].join('\n');
      await handleMessage(ctx, text, `[sticker] ${sticker.emoji || 'sticker'}`);
    }
  }));

  // --- Animations (GIFs) ---
  bot.on('animation', mediaHandler('animation', async (ctx) => {
    const channel = channelFor(ctx);
    const anim = ctx.message.animation;
    const ext = anim.file_name ? extFromUrl(anim.file_name) || '.mp4' : '.mp4';
    const file = await downloadTelegramFile(ctx, anim.file_id, channel, {
      fileName: anim.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const text = [
      caption,
      `GIF/animation received (${anim.duration}s, ${anim.width}x${anim.height}, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[animation] ${(anim.file_name || 'animation').substring(0, 60)}`);
  }));

  /** Send a media file to a Telegram chat */
  async function sendMedia(chatId: number, media: PushMedia, caption?: string, threadId?: number): Promise<void> {
    const ext = extFromUrl(media.filePath);
    const mime = mimeFromExt(ext);
    const type = media.type || inferMediaType(mime);
    const file = Input.fromLocalFile(media.filePath);
    const target = threadId ? { message_thread_id: threadId } : {};
    const extra = caption
      ? { caption, parse_mode: 'HTML' as const, ...target }
      : (threadId ? target : undefined);

    switch (type) {
      case 'photo':      await bot.telegram.sendPhoto(chatId, file, extra); break;
      case 'animation':  await bot.telegram.sendAnimation(chatId, file, extra); break;
      case 'video':      await bot.telegram.sendVideo(chatId, file, extra); break;
      case 'voice':      await bot.telegram.sendVoice(chatId, file, extra); break;
      case 'audio':      await bot.telegram.sendAudio(chatId, file, extra); break;
      case 'sticker':    await bot.telegram.sendSticker(chatId, file); break;
      case 'video_note': await bot.telegram.sendVideoNote(chatId, file as Exclude<typeof file, { url: string }>); break;
      case 'document':
      default:           await bot.telegram.sendDocument(chatId, file, extra); break;
    }
  }

  const pushHandler: PushHandler = async (channel, text, media?) => {
    const target = parseTelegramChannel(channel);
    if (!target) {
      console.error(`[telegram] invalid chat ID in channel: ${channel}`);
      return false;
    }
    try {
      if (media) {
        await sendMedia(target.chatId, media, text || undefined, target.threadId);
        console.log(`[telegram] push media -> ${channel}: ${media.filePath}`);
      }
      if (text && !media) {
        for (const chunk of splitText(text)) {
          const htmlOptions = target.threadId
            ? { parse_mode: 'HTML' as const, message_thread_id: target.threadId }
            : { parse_mode: 'HTML' as const };
          const plainOptions = target.threadId
            ? { message_thread_id: target.threadId }
            : undefined;
          await bot.telegram.sendMessage(target.chatId, chunk, htmlOptions)
            .catch(() => bot.telegram.sendMessage(target.chatId, chunk.replace(/<[^>]*>/g, ''), plainOptions));
        }
      }
      if (text || media) {
        const label = text ? text.substring(0, 80) + (text.length > 80 ? '...' : '') : `[media]`;
        console.log(`[telegram] push -> ${channel}: ${label}`);
      }
      return true;
    } catch (err) {
      console.error(`[telegram] push failed for ${channel}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  };

  return { bot, pushHandler };
}
