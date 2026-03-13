import type { CapabilityGuidance } from './capability-guidance.js';

/** Content block for multimodal messages (text + images) */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** NDJSON message written to claude's stdin */
export interface ClaudeInput {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
}

/** Any NDJSON event from claude's stdout */
export interface ClaudeEvent {
  type: string;
  subtype?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  };
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  session_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

/** Metadata about the channel a message originates from */
export interface ChannelContext {
  channel: string;
  adapter: string;
  userName?: string;
  chatTitle?: string;
  topicName?: string;
}

export interface SendMessageRequest {
  text: string;
  channel?: string;
}

export interface PushMedia {
  filePath: string;
  type?: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'animation' | 'sticker' | 'video_note';
}

/**
 * Pushes a message to a user through an adapter's native protocol,
 * bypassing ProcessManager entirely. Registered by adapters at startup.
 */
export type PushHandler = (channel: string, text: string, media?: PushMedia) => Promise<boolean>;

export interface SendMessageResponse {
  text: string;
  duration_ms: number;
  terminalKind?: 'ok' | 'capability_denied' | 'error';
  capabilityGuidance?: CapabilityGuidance;
  /** Optional operator-facing notice to surface alongside the reply. */
  system_notice?: string;
  /**
   * True if this message was coalesced into a subsequent queued message.
   * When set, the caller should skip sending a response — the combined
   * message's caller will handle it.
   */
  coalesced?: boolean;
  /** True if the session ended with an error (exit, crash, etc.) */
  is_error?: boolean;
}
