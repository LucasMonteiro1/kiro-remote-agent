/**
 * Wire protocol for the local WebSocket hub.
 *
 * The hub (see hub.ts) runs *inside this daemon process*, on the work PC,
 * and is now the single source of truth for chat state — replacing the
 * old design where every client (phone, daemon, every open Kiro IDE
 * window) polled the relay's Postgres database over HTTPS every few
 * seconds. There is no more polling anywhere in this system: every event
 * is pushed the moment it happens, to exactly the connections that care.
 *
 * Two kinds of clients connect to the hub:
 *
 *  - "extension": the Kiro Remote Bridge VS Code extension, one per open
 *    Kiro IDE window. Always connects over plain ws:// on localhost, since
 *    it runs on the same machine as this daemon. Authenticates with the
 *    static HUB_SHARED_SECRET (the direct replacement for the old
 *    AGENT_SHARED_SECRET, which used to authenticate HTTP calls to the
 *    relay instead).
 *  - "owner": the phone/browser PWA. Connects over wss:// through a
 *    Cloudflare Tunnel from anywhere on the internet. Authenticates with a
 *    short-lived JWT minted by the relay's POST /api/hub-token route
 *    right after a normal password login. The hub verifies that JWT's
 *    signature itself (HUB_TOKEN_SECRET, shared with the relay) — it never
 *    calls back to the relay or touches any database to do this.
 *
 * This file is duplicated by hand in kiro-remote-relay's
 * lib/hubProtocol.ts (the two repos don't share a package). Keep the wire
 * shapes identical when editing either copy.
 */

export type ToolApprovalDecision = 'approve' | 'deny' | 'approve_always';

/**
 * Every event variant carries an optional `sessionId`. `undefined` means
 * the event belongs to the original "default" chat (the daemon's fixed
 * kiro-cli session). A concrete session id means the event belongs to a
 * specific local Kiro IDE session opened from the phone's session viewer.
 *
 * Identical in shape to kiro-remote-relay's RelayEvent — only the name
 * differs, to make clear this is the hub's own copy.
 */
export type HubEvent =
  | { id: string; type: 'user_message'; text: string; createdAt: number; sessionId?: string }
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

export type HubEventType = HubEvent['type'];

/** Point-in-time snapshot of local Kiro IDE sessions, pushed by an extension. */
export interface LocalSessionSummary {
  id: string;
  title: string;
  status: string | null;
  workspacePaths: string[];
  modelId?: string;
  agentMode?: string;
  createdAt?: string;
  lastModifiedAt?: string;
}

export interface LocalSessionMessage {
  type: string;
  timestamp: string;
  text: string;
  operationType?: string;
  kind?: string;
  files?: string[];
  detail?: string;
}

export interface SessionDetailResultPayload {
  sessionId: string;
  title: string;
  status: string | null;
  messages: LocalSessionMessage[];
  truncated: boolean;
}

// --- Client -> Hub ---

export type ClientToHub =
  | { v: 1; kind: 'hello'; role: 'owner'; token: string }
  | { v: 1; kind: 'hello'; role: 'extension'; secret: string; hostLabel: string }
  | { v: 1; kind: 'send_message'; text: string; sessionId?: string }
  | {
      v: 1;
      kind: 'approval_response';
      requestId: string;
      decision: ToolApprovalDecision;
      sessionId?: string;
    }
  /**
   * Owner -> hub. Unlike the old design, this is answered by the daemon
   * *directly* (same process as the hub, same filesystem access to
   * ~/.kiro/sessions) — it is never forwarded to an extension over the
   * wire. See index.ts's `hub.onSessionDetailRequest`.
   */
  | { v: 1; kind: 'request_session_detail'; requestId: string; sessionId: string; since?: string }
  /**
   * Extension -> hub: report a new event (assistant reply, tool call, etc)
   * from a live IDE session. The hub assigns createdAt and, if the caller
   * didn't supply one, an id too. The extension supplies its own id only
   * for approval_request (see extension.ts's pushApprovalRequest for why).
   */
  | { v: 1; kind: 'push_event'; event: Omit<HubEvent, 'id' | 'createdAt'> & { id?: string } }
  /** Extension -> hub: an approval_request was answered directly in the IDE (not from the phone). */
  | { v: 1; kind: 'resolve_approval'; requestId: string; decision: ToolApprovalDecision }
  /**
   * Extension -> hub: single-delivery guard. Every open Kiro IDE window
   * runs its own extension and all of them receive every broadcast
   * `event`; before acting on one tagged for a session it owns, an
   * extension must claim it first — only the first caller gets
   * `claimed: true`. Direct in-memory replacement for the old
   * Postgres-backed event_claims table.
   */
  | { v: 1; kind: 'claim_event'; eventId: string; by?: string };

// --- Hub -> Client ---

export type HubToClient =
  | { v: 1; kind: 'welcome'; now: number }
  /**
   * Sent once, right after `welcome`, only to owner connections: replays
   * the hub's recent in-memory event log (chronological order) so a fresh
   * browser tab has something to show before the first new event arrives
   * — the in-memory replacement for the old relay's GET /api/events
   * initial page load.
   */
  | { v: 1; kind: 'history'; events: HubEvent[] }
  /** Sent to both owner and extension connections — extensions filter locally by sessionId/workspace, mirroring the old poll-everything-and-filter-locally design, just pushed instead of polled. */
  | { v: 1; kind: 'event'; event: HubEvent }
  | { v: 1; kind: 'local_sessions'; sessions: LocalSessionSummary[]; pushedAt: number }
  | { v: 1; kind: 'session_detail_result'; requestId: string; result: SessionDetailResultPayload }
  | { v: 1; kind: 'session_detail_error'; requestId: string; message: string }
  | { v: 1; kind: 'status'; online: boolean; hostLabel?: string }
  | { v: 1; kind: 'claim_result'; eventId: string; claimed: boolean }
  | { v: 1; kind: 'error'; message: string };
