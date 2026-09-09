import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentConfig } from './config';
import type { ClientToHub, HubEvent, HubToClient, MessageAttachment, ToolApprovalDecision } from './hubProtocol';
import type { SessionSummary } from './sessionScanner';

const MAX_EVENTS_IN_MEMORY = 2000; // bounds the internal approval-lookup index; Discord itself is now the durable chat log
const CLAIM_TTL_MS = 60 * 60 * 1000;

interface Connection {
  ws: WebSocket;
  hostLabel?: string;
}

type NewEvent = {
  [K in HubEvent['type']]: Omit<Extract<HubEvent, { type: K }>, 'id' | 'createdAt'> & {
    /** Optional caller-supplied id. Used by the IDE extension for approval_request, which needs to know its own event id synchronously to key its pendingApprovals map — a fire-and-forget WebSocket send can't hand back a server-generated id. */
    id?: string;
  };
}[HubEvent['type']];

export interface ApprovalResolvedInfo {
  requestId: string;
  decision: ToolApprovalDecision;
  sessionId?: string | null;
}

/**
 * The hub: an in-memory event bus, plus the local WebSocket server every
 * Kiro Remote Bridge extension (one per open Kiro IDE window) connects to.
 * Runs inside this daemon process, on the work PC.
 *
 * There is no more "owner" client here. That role — the remote human
 * client sending messages and answering approvals — used to be a
 * phone/browser PWA connecting over a Cloudflare Tunnel, authenticated
 * with a JWT minted by a separate relay service. It's now a Discord bot
 * (see discordBot.ts) that runs in this *same process*, so it talks to
 * the hub through plain in-process method calls (sendUserMessage,
 * respondToApproval) and the `onEvent`/`onApprovalResolved` callbacks
 * below — no network hop, no auth token, no wire protocol needed for it.
 *
 * The only thing left that genuinely needs a network connection is the
 * IDE extension, because it runs in a separate OS process (the IDE's
 * extension host), possibly one per open window.
 */
export class Hub {
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<Connection>();
  private readonly events: HubEvent[] = [];
  private readonly claims = new Map<string, number>();
  private localSessions: SessionSummary[] = [];

  constructor(private readonly config: AgentConfig) {
    this.wss = new WebSocketServer({ port: config.HUB_PORT });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('listening', () => {
      console.log(`[hub] listening on ws://127.0.0.1:${config.HUB_PORT}`);
    });
  }

  stop(): void {
    this.wss.close();
  }

  // --- called by Discord (the new "owner") ---

  /**
   * Sends a chat message, either into the daemon's own default session
   * (sessionId omitted) or a specific local IDE session/new-session flow.
   *
   * `id`, if supplied, lets the caller (discordBot.ts) recognize this exact
   * event when it comes back through `onEvent` — since `recordAndBroadcast`
   * notifies `onEvent` synchronously, before this method even returns, the
   * caller has to pre-register the id *before* calling this, not after.
   * discordBot.ts uses this to tell "a message that originated in a Discord
   * thread" (already visible there, no need to re-post) apart from "a
   * user_message pushed by the IDE extension" (needs posting).
   */
  sendUserMessage(text: string, sessionId?: string, id?: string, attachments?: MessageAttachment[]): HubEvent {
    const event = this.emitEvent({
      type: 'user_message',
      text,
      sessionId,
      id,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    this.onUserMessage?.(event);
    return event;
  }

  /** Answers a pending approval_request. Mirrors the old owner-authenticated HTTP route: marks it resolved, broadcasts an approval_response the extension acts on, and notifies the daemon's own default session if that's who it belongs to. */
  respondToApproval(requestId: string, decision: ToolApprovalDecision, sessionId?: string): void {
    const resolvedSessionId = this.resolveApproval(requestId, decision);
    const event = this.emitEvent({
      type: 'approval_response',
      requestId,
      decision,
      sessionId: resolvedSessionId ?? sessionId,
    });
    this.onApprovalResponse?.(event);
  }

  // --- called by index.ts for the daemon's own default KiroSession ---

  emitEvent(event: NewEvent): HubEvent {
    const full = { ...event, id: event.id ?? randomUUID(), createdAt: Date.now() } as HubEvent;
    this.recordAndBroadcast(full);
    return full;
  }

  pushAssistantMessage(text: string, sessionId?: string): void {
    this.emitEvent({ type: 'assistant_message', text, sessionId });
  }

  pushStatus(text: string, sessionId?: string): void {
    this.emitEvent({ type: 'status', text, sessionId });
  }

  pushError(text: string, sessionId?: string): void {
    this.emitEvent({ type: 'error', text, sessionId });
  }

  /** Returns the id of the created approval_request event. */
  pushApprovalRequest(promptText: string, sessionId?: string, toolName?: string): string {
    return this.emitEvent({ type: 'approval_request', promptText, toolName, sessionId }).id;
  }

  /** Used by index.ts's periodic ~/.kiro/sessions scan. Purely a local cache now — nothing broadcasts it over the wire; Discord's /sessions command reads it via getLocalSessions(). */
  setLocalSessions(sessions: SessionSummary[]): void {
    this.localSessions = sessions;
    this.onLocalSessions?.(sessions);
  }

  getLocalSessions(): SessionSummary[] {
    return this.localSessions;
  }

  // --- hooks the daemon (index.ts) wires up for its own fixed session ---

  onUserMessage: ((event: HubEvent) => void) | null = null;
  onApprovalResponse: ((event: HubEvent) => void) | null = null;

  /** Wired by discordBot.ts: fires for every event from any source (Discord, the daemon's default session, or any IDE extension window), so Discord can mirror it into the right thread. */
  onEvent: ((event: HubEvent) => void) | null = null;

  /** Wired by discordBot.ts: fires whenever an approval_request is resolved, regardless of source (Discord buttons, or resolved directly in the IDE), so Discord can edit the original message to show the outcome. */
  onApprovalResolved: ((info: ApprovalResolvedInfo) => void) | null = null;

  /** Wired by discordBot.ts: fires each time the periodic ~/.kiro/sessions scan refreshes local session metadata, so Discord can rename its threads to match the title Kiro (re)assigned to a session. */
  onLocalSessions: ((sessions: SessionSummary[]) => void) | null = null;

  // --- connection handling (IDE extensions only) ---

  private handleConnection(ws: WebSocket): void {
    const conn: Connection = { ws };
    let authenticated = false;
    let helloTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'hello timeout');
    }, 10_000);

    ws.on('message', (raw) => {
      let msg: ClientToHub;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!authenticated) {
        if (msg.kind !== 'hello') return;
        if (!timingSafeEqual(msg.secret, this.config.HUB_SHARED_SECRET)) {
          ws.close(4003, 'unauthorized');
          return;
        }
        authenticated = true;
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        conn.hostLabel = msg.hostLabel;
        this.connections.add(conn);
        this.send(ws, { v: 1, kind: 'welcome', now: Date.now() });
        return;
      }

      this.handleMessage(conn, msg);
    });

    ws.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer);
      this.connections.delete(conn);
    });

    ws.on('error', () => {
      // 'close' fires right after; nothing extra to do here.
    });
  }

  private handleMessage(_conn: Connection, msg: ClientToHub): void {
    switch (msg.kind) {
      case 'push_event': {
        this.emitEvent(msg.event as NewEvent);
        return;
      }
      case 'resolve_approval': {
        this.resolveApproval(msg.requestId, msg.decision);
        return;
      }
      case 'claim_event': {
        const claimed = this.claimEvent(msg.eventId);
        this.send(_conn.ws, { v: 1, kind: 'claim_result', eventId: msg.eventId, claimed });
        return;
      }
      default:
        return;
    }
  }

  /** True only for the first caller within CLAIM_TTL_MS of a given eventId — lets multiple open IDE windows share the same event stream without double-delivering a message. */
  private claimEvent(eventId: string): boolean {
    const now = Date.now();
    const expiresAt = this.claims.get(eventId);
    if (expiresAt && expiresAt > now) return false;
    this.claims.set(eventId, now + CLAIM_TTL_MS);
    return true;
  }

  // --- approvals ---

  /** Marks a pending approval_request resolved in-place; returns its sessionId (or null for the default session), or undefined if not found. Fires onApprovalResolved either way it succeeds. */
  private resolveApproval(requestId: string, decision: ToolApprovalDecision): string | null | undefined {
    const target = this.events.find((e) => e.id === requestId && e.type === 'approval_request');
    if (!target || target.type !== 'approval_request') return undefined;
    target.resolvedAt = Date.now();
    target.decision = decision;
    const sessionId = target.sessionId ?? null;
    this.onApprovalResolved?.({ requestId, decision, sessionId });
    return sessionId;
  }

  // --- broadcast plumbing ---

  private recordAndBroadcast(event: HubEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY);
    }

    // Every open Kiro IDE window's extension needs to see every event so
    // it can locally decide (by sessionId + workspace) whether it's the
    // one that should act on it.
    for (const conn of this.connections) {
      this.send(conn.ws, { v: 1, kind: 'event', event });
    }

    // Discord's single subscription point — it displays every event
    // regardless of source.
    this.onEvent?.(event);
  }

  private send(ws: WebSocket, msg: HubToClient): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}
