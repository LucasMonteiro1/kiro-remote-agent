import 'dotenv/config';
import { loadConfig } from './config';
import { Hub } from './hub';
import { KiroSession } from './kiroSession';
import { scanSessionSummaries, readSessionTranscript } from './sessionScanner';
import type { HubEvent } from './hubProtocol';

async function main() {
  const config = loadConfig();
  const hub = new Hub(config);

  // requestId -> resolve callback, used to route an approval decision from
  // the phone back into a "send keystrokes to the PTY" action, for the
  // daemon's own fixed default session.
  let lastApprovalRequestId: string | null = null;

  const session = new KiroSession(
    config,
    { label: 'default', cwd: config.KIRO_PROJECT_DIR, resumeSessionId: config.KIRO_SESSION_ID },
    (turnText) => {
      hub.pushAssistantMessage(turnText);
    },
    (promptText) => {
      lastApprovalRequestId = hub.pushApprovalRequest(promptText);
    },
    (noticeText) => {
      hub.pushError(noticeText);
    },
  );

  session.start();
  hub.pushStatus(`Agente conectado em ${config.HOST_LABEL}.`);

  // Session transcript requests from the phone are answered directly here
  // — the hub and this daemon share the same filesystem, so unlike the old
  // design (phone -> relay -> queue -> daemon polls -> relay -> phone
  // polls), there's no round trip through anything at all beyond this one
  // read + one reply.
  hub.onSessionDetailRequest = (ws, requestId, sessionId, since) => {
    try {
      const detail = readSessionTranscript(sessionId, since);
      if (!detail) {
        hub.replySessionDetailError(ws, requestId, 'Sessão não encontrada em ~/.kiro/sessions neste PC.');
        return;
      }
      hub.replySessionDetail(ws, requestId, { sessionId, ...detail });
    } catch (err) {
      hub.replySessionDetailError(ws, requestId, describeError(err));
    }
  };

  // Events for the daemon's own default chat arrive as direct hub
  // callbacks now, not through a poll loop — no network hop, no delay.
  hub.onUserMessage = (event: HubEvent) => {
    if (event.type !== 'user_message') return;
    // Events tagged with a sessionId target a Kiro IDE chat session. Those
    // are delivered by the Kiro Remote Bridge extension running inside the
    // IDE (see ide-extension/), because an IDE-owned session can only be
    // driven by the IDE's own agent client — spawning a separate kiro-cli
    // here would create a disconnected process that never shows up in the
    // IDE and loses its MCP context. Nothing to do here for those.
    if (event.sessionId) return;
    session.sendMessage(event.text);
  };

  hub.onApprovalResponse = (event: HubEvent) => {
    if (event.type !== 'approval_response') return;
    if (event.sessionId) return; // handled by the extension, not this daemon
    const targetId = event.requestId || lastApprovalRequestId;
    if (targetId) {
      applyApprovalDecision(session, config, event.decision);
    }
  };

  // --- Local Kiro IDE session history tracking (read-only, ~/.kiro/sessions) ---
  // This still needs a timer (scanning the filesystem isn't event-driven),
  // but it's now a local push to the in-process hub instead of an HTTP
  // POST to a remote relay.
  function sessionScanLoop(): void {
    try {
      const summaries = scanSessionSummaries();
      hub.setLocalSessions(summaries);
    } catch (err) {
      logError('session scan loop', err);
    } finally {
      setTimeout(sessionScanLoop, config.SESSION_SCAN_INTERVAL_MS);
    }
  }

  sessionScanLoop();

  process.on('SIGINT', () => shutdown(session, hub));
  process.on('SIGTERM', () => shutdown(session, hub));
}

function applyApprovalDecision(
  session: KiroSession,
  config: ReturnType<typeof loadConfig>,
  decision: 'approve' | 'deny' | 'approve_always',
): void {
  switch (decision) {
    case 'approve':
      session.sendKeystrokes(config.APPROVE_KEYSTROKES);
      break;
    case 'approve_always':
      session.sendKeystrokes(config.APPROVE_ALWAYS_KEYSTROKES);
      break;
    case 'deny':
      session.sendKeystrokes(config.DENY_KEYSTROKES);
      break;
  }
}

function shutdown(session: KiroSession, hub: Hub): void {
  session.stop();
  hub.stop();
  process.exit(0);
}

function logError(context: string, err: unknown): void {
  console.error(`[kiro-remote-agent] ${context} failed:`, err);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error('[kiro-remote-agent] fatal error:', err);
  process.exit(1);
});
