import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { jwtVerify } from 'jose';
import type { AgentConfig } from './config';
import type {
  ClientToHub,
  HubEvent,
  HubToClient,
  LocalSessionSummary,
  SessionDetailResultPayload,
  ToolApprovalDecision,
} from './hubProtocol';
import { getSql } from './db';

const MAX_EVENTS_IN_MEMORY = 2000; // same bound the old Postgres event log used
const FLUSH_INTERVAL_MS = 15_000; // batches durability writes instead of one per event
const CLAIM_TTL_MS = 60 * 60 * 1000; // same window the old event_claims table used

interface Connection {
  ws: WebSocket;
  role: 'owner' | 'extension';
  hostLabel?: string;
  /** Only meaningful for owner connections: which chat thread they're subscribed to (undefined = default chat). */
  subscribedSessionId?: string | 'ALL';
}

type NewEvent = {
  [K in HubEvent['type']]: Omit<Extract<HubEvent, { type: K }>, 'id' | 'createdAt'> & {
    /** Optional caller-supplied id. Used by the IDE extension for approval_request, which needs to know its own event id synchronously (before any reply could arrive) to key its pendingApprovals map — a fire-and-forget WebSocket send can't hand back a server-generated id the way the old HTTP push() response did. */
    id?: string;
  };
}[HubEvent['type']];

/**
 * The hub: an in-memory event bus for one owner's chat, plus the WebSocket
 * server every client (phone/browser, and every Kiro IDE window's bridge
 * extension) connects to. Runs inside this daemon process, on the work PC.
 *
 * This directly replaces what used to be a Postgres-backed relay polled by
 * every client every few seconds. Now:
 *  - state lives in memory (the `events` array below) — no round trip to any
 *    database on the read or write path;
 *  - every event is pushed the instant it happens to every connection that
 *    should see it, instead of a client finding out up to POLL_INTERVAL_MS
 *    later;
 *  - Postgres (if DATABASE_URL is set) is used purely for durability: a
 *    batched flush every FLUSH_INTERVAL_MS, not a query per event. Losing
 *    up to that window of history on a daemon crash is an acceptable
 *    trade for a personal chat log capped at MAX_EVENTS_IN_MEMORY anyway.
 */
export class Hub {
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<Connection>();
  private readonly events: HubEvent[] = [];
  private readonly localSessions = new Map<string, { sessions: LocalSessionSummary[]; pushedAt: number }>();
  /** eventId -> expiry, mirroring the old Postgres event_claims table's single-delivery guard. */
  private readonly claims = new Map<string, number>();
  private unflushedEvents: HubEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatHost: string | undefined;

  constructor(private readonly config: AgentConfig) {
    this.wss = new WebSocketServer({ port: config.HUB_PORT });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('listening', () => {
      console.log(`[hub] listening on ws://127.0.0.1:${config.HUB_PORT}`);
    });

    if (config.DATABASE_URL) {
      this.flushTimer = setInterval(() => void this.flushToPostgres(), FLUSH_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    void this.flushToPostgres();
    this.wss.close();
  }

  /** True if any extension connection has sent a message in the last ONLINE_THRESHOLD_MS-equivalent window. Used only for local status logging. */
  isAnyExtensionConnected(): boolean {
    for (const conn of this.connections) {
      if (conn.role === 'extension') return true;
    }
    return false;
  }

  // --- called by index.ts / sessionManager.ts for the daemon's own default session ---

  emitEvent(event: NewEvent): HubEvent {
    const full = { ...event, id: event.id ?? randomUUID(), createdAt: Date.now() } as HubEvent;
    this.recordAndBroadcast(full);
    return full;
  }

  // --- convenience wrappers used by index.ts/sessionManager.ts for the
  // daemon's own KiroSession instances. These call emitEvent directly —
  // there's no network hop here, the daemon and the hub are the same
  // process, so this replaces what used to be RelayClient's HTTP calls
  // with a plain in-process method call. ---

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

  /** Used by the daemon's own periodic ~/.kiro/sessions scan (index.ts's sessionScanLoop). */
  setLocalSessions(sessions: LocalSessionSummary[]): void {
    this.localSessions.set('__default__', { sessions, pushedAt: Date.now() });
    this.broadcastToOwners({ v: 1, kind: 'local_sessions', sessions, pushedAt: Date.now() });
  }

  // --- connection handling ---

  private handleConnection(ws: WebSocket): void {
    const conn: Connection = { ws, role: 'owner' };
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
        void this.authenticate(msg, conn).then((ok) => {
          if (!ok) {
            ws.close(4003, 'unauthorized');
            return;
          }
          authenticated = true;
          if (helloTimer) {
            clearTimeout(helloTimer);
            helloTimer = null;
          }
          this.connections.add(conn);
          this.onAuthenticated(conn);
        });
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

  private async authenticate(
    msg: Extract<ClientToHub, { kind: 'hello' }>,
    conn: Connection,
  ): Promise<boolean> {
    if (msg.role === 'extension') {
      const expected = this.config.HUB_SHARED_SECRET;
      if (!timingSafeEqual(msg.secret, expected)) return false;
      conn.role = 'extension';
      conn.hostLabel = msg.hostLabel;
      return true;
    }

    // role === 'owner': verify the short-lived JWT minted by the relay's
    // /api/hub-token route. This is the *only* thing that ever touches the
    // relay in the new design, and even that is a signature check done
    // entirely locally — no network call back to the relay or Postgres.
    try {
      const key = new TextEncoder().encode(this.config.HUB_TOKEN_SECRET);
      const { payload } = await jwtVerify(msg.token, key);
      return payload.role === 'owner';
    } catch {
      return false;
    }
  }

  private onAuthenticated(conn: Connection): void {
    this.send(conn.ws, { v: 1, kind: 'welcome', now: Date.now() });

    if (conn.role === 'extension') {
      this.lastHeartbeatAt = Date.now();
      this.lastHeartbeatHost = conn.hostLabel;
      this.broadcastStatus();
    } else {
      // Owner just connected: replay recent history, the current
      // local-sessions snapshot, and the current online status, so the UI
      // has something to show before the first new event arrives — the
      // in-memory equivalent of the old relay's initial GET /api/events
      // and GET /api/local-sessions calls on page load.
      this.send(conn.ws, { v: 1, kind: 'history', events: this.events });
      this.send(conn.ws, { v: 1, kind: 'status', online: this.isOnline(), hostLabel: this.lastHeartbeatHost });
      const defaultSnapshot = this.localSessions.get('__default__');
      if (defaultSnapshot) {
        this.send(conn.ws, {
          v: 1,
          kind: 'local_sessions',
          sessions: defaultSnapshot.sessions,
          pushedAt: defaultSnapshot.pushedAt,
        });
      }
    }
  }

  private handleMessage(conn: Connection, msg: ClientToHub): void {
    switch (msg.kind) {
      case 'send_message': {
        const event = this.emitEvent({ type: 'user_message', text: msg.text, sessionId: msg.sessionId });
        this.onUserMessage?.(event);
        return;
      }
      case 'approval_response': {
        const sessionId = this.resolveApproval(msg.requestId, msg.decision);
        const event = this.emitEvent({
          type: 'approval_response',
          requestId: msg.requestId,
          decision: msg.decision,
          sessionId: sessionId ?? msg.sessionId,
        });
        this.onApprovalResponse?.(event);
        return;
      }
      case 'push_event': {
        this.emitEvent(msg.event as NewEvent);
        return;
      }
      case 'request_session_detail': {
        // Answered directly by the daemon (same process, same disk access
        // to ~/.kiro/sessions) — see index.ts's onSessionDetailRequest.
        // Unlike every other message here, this needs to reply only to
        // the requesting connection, not broadcast, so it's routed via a
        // callback rather than handled inline in this switch.
        this.onSessionDetailRequest?.(conn.ws, msg.requestId, msg.sessionId, msg.since);
        return;
      }
      case 'resolve_approval': {
        this.resolveApproval(msg.requestId, msg.decision);
        return;
      }
      case 'claim_event': {
        const claimed = this.claimEvent(msg.eventId, msg.by);
        this.send(conn.ws, { v: 1, kind: 'claim_result', eventId: msg.eventId, claimed });
        return;
      }
      default:
        return;
    }
  }

  // --- hooks the daemon (index.ts) wires up for its own fixed session ---

  onUserMessage: ((event: HubEvent) => void) | null = null;
  onApprovalResponse: ((event: HubEvent) => void) | null = null;
  /** Wired by index.ts to answer directly from ~/.kiro/sessions, no extension round trip needed. */
  onSessionDetailRequest:
    | ((ws: WebSocket, requestId: string, sessionId: string, since: string | undefined) => void)
    | null = null;

  /** Called by index.ts once it has read the transcript, to deliver the result back to the exact connection that asked. */
  replySessionDetail(ws: WebSocket, requestId: string, result: SessionDetailResultPayload): void {
    this.send(ws, { v: 1, kind: 'session_detail_result', requestId, result });
  }

  replySessionDetailError(ws: WebSocket, requestId: string, message: string): void {
    this.send(ws, { v: 1, kind: 'session_detail_error', requestId, message });
  }

  /** True only for the first caller within CLAIM_TTL_MS of a given eventId — direct in-memory replacement for the old Postgres event_claims table's atomic INSERT ... ON CONFLICT. */
  private claimEvent(eventId: string, _by: string | undefined): boolean {
    const now = Date.now();
    const expiresAt = this.claims.get(eventId);
    if (expiresAt && expiresAt > now) return false;
    this.claims.set(eventId, now + CLAIM_TTL_MS);
    return true;
  }

  // --- approvals ---

  /** Marks a pending approval_request resolved in-place; returns its sessionId (or null for default chat), or undefined if not found. */
  private resolveApproval(requestId: string, decision: ToolApprovalDecision): string | null | undefined {
    const target = this.events.find((e) => e.id === requestId && e.type === 'approval_request');
    if (!target || target.type !== 'approval_request') return undefined;
    target.resolvedAt = Date.now();
    target.decision = decision;
    return target.sessionId ?? null;
  }

  // --- broadcast plumbing ---

  private recordAndBroadcast(event: HubEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY);
    }
    this.unflushedEvents.push(event);

    for (const conn of this.connections) {
      if (conn.role !== 'owner') continue;
      this.send(conn.ws, { v: 1, kind: 'event', event });
    }
  }

  private broadcastToOwners(msg: HubToClient): void {
    for (const conn of this.connections) {
      if (conn.role === 'owner') this.send(conn.ws, msg);
    }
  }

  private broadcastStatus(): void {
    this.broadcastToOwners({ v: 1, kind: 'status', online: true, hostLabel: this.lastHeartbeatHost });
  }

  private isOnline(): boolean {
    return this.isAnyExtensionConnected();
  }

  private send(ws: WebSocket, msg: HubToClient): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  // --- durability (optional) ---

  /**
   * Flushes whatever accumulated since the last flush into Postgres, one
   * batched INSERT rather than one write per event. Purely for durability
   * across daemon restarts — nothing in the hot read/write path depends on
   * this succeeding, so a failure here is logged and swallowed rather than
   * surfaced to any client.
   */
  private async flushToPostgres(): Promise<void> {
    if (this.unflushedEvents.length === 0) return;
    const batch = this.unflushedEvents;
    this.unflushedEvents = [];

    try {
      const sql = getSql(this.config.DATABASE_URL!);
      for (const event of batch) {
        await sql`
          INSERT INTO events (id, type, session_id, created_at, data)
          VALUES (${event.id}, ${event.type}, ${event.sessionId ?? null}, ${event.createdAt}, ${JSON.stringify(event)}::jsonb)
          ON CONFLICT (id) DO NOTHING
        `;
      }
    } catch (err) {
      console.error('[hub] durability flush failed:', err);
      // Not re-queued: these events are still in `this.events` (in-memory)
      // and will be retried on the *next* flush tick only if still
      // unflushed, which they aren't once popped here. Acceptable: this is
      // a best-effort durability layer, not the source of truth.
    }
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
