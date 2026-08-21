import type { AgentConfig } from './config';
import type { SessionMessage, SessionSummary } from './sessionScanner';

export type RelayEvent =
  | { id: string; type: 'user_message'; text: string; createdAt: number }
  | {
      id: string;
      type: 'approval_response';
      requestId: string;
      decision: 'approve' | 'deny' | 'approve_always';
      createdAt: number;
    };

export class RelayClient {
  private cursor = 0;

  constructor(private readonly config: AgentConfig) {}

  async pull(): Promise<RelayEvent[]> {
    const url = new URL('/api/agent/pull', this.config.RELAY_URL);
    url.searchParams.set('since', String(this.cursor));
    url.searchParams.set('host', this.config.HOST_LABEL);

    const res = await fetch(url, {
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

  async pushAssistantMessage(text: string): Promise<void> {
    await this.push({ type: 'assistant_message', text });
  }

  async pushStatus(text: string): Promise<void> {
    await this.push({ type: 'status', text });
  }

  async pushError(text: string): Promise<void> {
    await this.push({ type: 'error', text });
  }

  /** Returns the relay-assigned id of the created approval_request event. */
  async pushApprovalRequest(promptText: string, toolName?: string): Promise<string> {
    const event = await this.push({ type: 'approval_request', promptText, toolName });
    return event.id;
  }

  /** Overwrites the relay's snapshot of local Kiro IDE sessions. */
  async pushLocalSessions(sessions: SessionSummary[]): Promise<void> {
    const url = new URL('/api/agent/local-sessions', this.config.RELAY_URL);
    const res = await fetch(url, {
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
  ): Promise<{ id: string; sessionId: string; createdAt: number }[]> {
    const url = new URL('/api/agent/session-detail-requests', this.config.RELAY_URL);
    url.searchParams.set('since', String(sinceMs));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}` },
    });

    if (!res.ok) {
      throw new Error(`Relay pullSessionDetailRequests failed: ${res.status} ${await safeText(res)}`);
    }

    const body = (await res.json()) as {
      requests: { id: string; sessionId: string; createdAt: number }[];
    };
    return body.requests;
  }

  /** Posts a session transcript back to the relay in response to a detail request. */
  async pushSessionDetailResult(
    requestId: string,
    sessionId: string,
    title: string,
    messages: SessionMessage[],
    truncated: boolean,
  ): Promise<void> {
    const url = new URL('/api/agent/session-detail-result', this.config.RELAY_URL);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.AGENT_SHARED_SECRET}`,
      },
      body: JSON.stringify({ requestId, sessionId, title, messages, truncated }),
    });

    if (!res.ok) {
      throw new Error(`Relay pushSessionDetailResult failed: ${res.status} ${await safeText(res)}`);
    }
  }

  private async push(
    payload:
      | { type: 'assistant_message'; text: string }
      | { type: 'status'; text: string }
      | { type: 'error'; text: string }
      | { type: 'approval_request'; promptText: string; toolName?: string },
  ): Promise<{ id: string }> {
    const url = new URL('/api/agent/push', this.config.RELAY_URL);
    const res = await fetch(url, {
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
