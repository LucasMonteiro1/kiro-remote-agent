import type { AgentConfig } from './config';
import type { SessionMessage, SessionSummary } from './sessionScanner';

// Guards against a wedged TCP socket (typical after the laptop sleeps or
// switches networks): without this, a dead connection can leave `fetch`
// pending forever — neither resolving nor rejecting — which stalls the
// polling loop's `finally` block and stops it from ever scheduling its
// next attempt. An explicit timeout guarantees every call eventually
// settles one way or another.
const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type RelayEvent =
  | { id: string; type: 'user_message'; text: string; createdAt: number; sessionId?: string }
  | {
      id: string;
      type: 'approval_response';
      requestId: string;
      decision: 'approve' | 'deny' | 'approve_always';
      createdAt: number;
      sessionId?: string;
    };

export class RelayClient {
  // A single cursor is fine: /api/agent/pull returns events across every
  // chat thread (default + all open local sessions), each already tagged
  // with its own sessionId, so index.ts can dispatch them locally.
  private cursor = 0;

  constructor(private readonly config: AgentConfig) {}

  async pull(): Promise<RelayEvent[]> {
    const url = new URL('/api/agent/pull', this.config.RELAY_URL);
    url.searchParams.set('since', String(this.cursor));
    url.searchParams.set('host', this.config.HOST_LABEL);

    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}` },
    });

    if (!res.ok) {
      throw new Error(`Relay pull failed: ${res.status} ${await safeText(res)}`);
    }

    const body = (await res.json()) as { events: RelayEvent[]; now: number };
    if (body.events.length > 0) {
      this.cursor = Math.max(this.cursor, ...body.events.map((e) => e.createdAt));
    }
    return body.events;
  }

  async pushAssistantMessage(text: string, sessionId?: string): Promise<void> {
    await this.push({ type: 'assistant_message', text, sessionId });
  }

  async pushStatus(text: string, sessionId?: string): Promise<void> {
    await this.push({ type: 'status', text, sessionId });
  }

  async pushError(text: string, sessionId?: string): Promise<void> {
    await this.push({ type: 'error', text, sessionId });
  }

  /** Returns the relay-assigned id of the created approval_request event. */
  async pushApprovalRequest(promptText: string, sessionId?: string, toolName?: string): Promise<string> {
    const event = await this.push({ type: 'approval_request', promptText, toolName, sessionId });
    return event.id;
  }

  /** Overwrites the relay's snapshot of local Kiro IDE sessions. */
  async pushLocalSessions(sessions: SessionSummary[]): Promise<void> {
    const url = new URL('/api/agent/local-sessions', this.config.RELAY_URL);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}`,
      },
      body: JSON.stringify({ sessions }),
    });

    if (!res.ok) {
      throw new Error(`Relay pushLocalSessions failed: ${res.status} ${await safeText(res)}`);
    }
  }

  /** Polls for pending "fetch this session's transcript" requests from the phone. */
  async pullSessionDetailRequests(
    sinceMs: number,
  ): Promise<{ id: string; sessionId: string; createdAt: number; sinceTimestamp?: string }[]> {
    const url = new URL('/api/agent/session-detail-requests', this.config.RELAY_URL);
    url.searchParams.set('since', String(sinceMs));

    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}` },
    });

    if (!res.ok) {
      throw new Error(`Relay pullSessionDetailRequests failed: ${res.status} ${await safeText(res)}`);
    }

    const body = (await res.json()) as {
      requests: { id: string; sessionId: string; createdAt: number; sinceTimestamp?: string }[];
    };
    return body.requests;
  }

  /** Posts a session transcript back to the relay in response to a detail request. */
  async pushSessionDetailResult(
    requestId: string,
    sessionId: string,
    title: string,
    status: string | null,
    messages: SessionMessage[],
    truncated: boolean,
  ): Promise<void> {
    const url = new URL('/api/agent/session-detail-result', this.config.RELAY_URL);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}`,
      },
      body: JSON.stringify({ requestId, sessionId, title, status, messages, truncated }),
    });

    if (!res.ok) {
      throw new Error(`Relay pushSessionDetailResult failed: ${res.status} ${await safeText(res)}`);
    }
  }

  private async push(
    payload:
      | { type: 'assistant_message'; text: string; sessionId?: string }
      | { type: 'status'; text: string; sessionId?: string }
      | { type: 'error'; text: string; sessionId?: string }
      | { type: 'approval_request'; promptText: string; toolName?: string; sessionId?: string },
  ): Promise<{ id: string }> {
    const url = new URL('/api/agent/push', this.config.RELAY_URL);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Relay push failed: ${res.status} ${await safeText(res)}`);
    }

    const body = (await res.json()) as { event: { id: string } };
    return body.event;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
