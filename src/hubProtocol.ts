/**
 * Wire protocol between the hub (hub.ts) and the Kiro Remote Bridge
 * extension running inside each open Kiro IDE window.
 *
 * This used to also define a WebSocket contract for a remote "owner"
 * client (the phone/browser PWA, authenticated with a JWT minted by a
 * separate relay service). That whole side has been replaced by a Discord
 * bot (see discordBot.ts) that runs in the same process as this daemon —
 * it talks to the hub through plain in-process method calls
 * (hub.sendUserMessage, hub.respondToApproval, hub.onEvent) instead of a
 * network connection, so there's no wire protocol needed for it anymore.
 *
 * What's left here is purely local: the extension runs in a separate OS
 * process (the IDE's extension host) and connects over
 * ws://127.0.0.1:<HUB_PORT>, authenticating with the static
 * HUB_SHARED_SECRET.
 */

export type ToolApprovalDecision = 'approve' | 'deny' | 'approve_always';

/**
 * An image (or other file) attached to a user_message, as sent from
 * Discord. Only the URL/filename/contentType travel over the wire — the
 * actual bytes are downloaded on demand by whoever delivers the message
 * (the daemon's PTY session or the IDE extension), saved to a local temp
 * file, and referenced by absolute path in the prompt so kiro-cli / the
 * Kiro IDE can read the image with its file tools. Discord attachment URLs
 * are public but time-limited, which is why they're fetched promptly at
 * delivery rather than kept around.
 */
export interface MessageAttachment {
  url: string;
  filename: string;
  contentType?: string;
}

/**
 * Every event variant carries an optional `sessionId`. `undefined` means
 * the event belongs to the original "default" chat (the daemon's fixed
 * kiro-cli session, mapped to a persistent Discord thread). A concrete
 * session id means the event belongs to a specific local Kiro IDE session,
 * mapped to its own Discord thread.
 */
export type HubEvent =
  | {
      id: string;
      type: 'user_message';
      text: string;
      createdAt: number;
      sessionId?: string;
      /** Image (or other file) attachments from Discord, delivered by absolute local path after download. */
      attachments?: MessageAttachment[];
    }
  | { id: string; type: 'assistant_message'; text: string; createdAt: number; sessionId?: string }
  | { id: string; type: 'thought'; text: string; createdAt: number; sessionId?: string }
  | {
      id: string;
      type: 'tool_call';
      title: string;
      toolName?: string;
      kind?: string;
      files?: string[];
      detail?: string;
      createdAt: number;
      sessionId?: string;
    }
  | { id: string; type: 'status'; text: string; createdAt: number; sessionId?: string }
  | { id: string; type: 'error'; text: string; createdAt: number; sessionId?: string }
  | {
      id: string;
      type: 'approval_request';
      promptText: string;
      toolName?: string;
      createdAt: number;
      sessionId?: string;
      resolvedAt?: number;
      decision?: ToolApprovalDecision;
    }
  | {
      id: string;
      type: 'approval_response';
      requestId: string;
      decision: ToolApprovalDecision;
      createdAt: number;
      sessionId?: string;
    };

// --- Extension -> Hub ---

export type ClientToHub =
  | { v: 1; kind: 'hello'; secret: string; hostLabel: string }
  /**
   * Report a new event (assistant reply, tool call, etc) from a live IDE
   * session. The hub assigns createdAt and, if the caller didn't supply
   * one, an id too. The extension supplies its own id only for
   * approval_request (see extension.ts's pushApprovalRequest for why).
   */
  | { v: 1; kind: 'push_event'; event: Omit<HubEvent, 'id' | 'createdAt'> & { id?: string } }
  /** An approval_request was answered directly in the IDE (not from Discord). */
  | { v: 1; kind: 'resolve_approval'; requestId: string; decision: ToolApprovalDecision }
  /**
   * Single-delivery guard. Every open Kiro IDE window runs its own
   * extension and all of them receive every broadcast `event`; before
   * acting on one tagged for a session it owns, an extension must claim
   * it first — only the first caller gets `claimed: true`.
   */
  | { v: 1; kind: 'claim_event'; eventId: string; by?: string };

// --- Hub -> Extension ---

export type HubToClient =
  | { v: 1; kind: 'welcome'; now: number }
  /** Every event, from any source (Discord, the daemon's default session, or another extension window) — the extension filters locally by sessionId/workspace. */
  | { v: 1; kind: 'event'; event: HubEvent }
  | { v: 1; kind: 'claim_result'; eventId: string; claimed: boolean }
  | { v: 1; kind: 'error'; message: string };
