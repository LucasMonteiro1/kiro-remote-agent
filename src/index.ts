import 'dotenv/config';
import { loadConfig } from './config';
import { RelayClient } from './relayClient';
import { KiroSession } from './kiroSession';
import { scanSessionSummaries, readSessionTranscript } from './sessionScanner';

async function main() {
  const config = loadConfig();
  const relay = new RelayClient(config);

  // requestId -> resolve callback, used to route an approval decision from
  // the phone back into a "send keystrokes to the PTY" action.
  let lastApprovalRequestId: string | null = null;

  const session = new KiroSession(
    config,
    { label: 'default', cwd: config.KIRO_PROJECT_DIR, resumeSessionId: config.KIRO_SESSION_ID },
    (turnText) => {
      relay.pushAssistantMessage(turnText).catch((err) => logError('push assistant_message', err));
    },
    (promptText) => {
      relay
        .pushApprovalRequest(promptText)
        .then((requestId) => {
          lastApprovalRequestId = requestId;
        })
        .catch((err) => logError('push approval_request', err));
    },
    (noticeText) => {
      relay.pushError(noticeText).catch((err) => logError('push system notice', err));
    },
  );

  session.start();
  await relay.pushStatus(`Agente conectado em ${config.HOST_LABEL}.`).catch(() => {});

  async function pollLoop() {
    try {
      const events = await relay.pull();
      for (const event of events) {
        // Events tagged with a sessionId target a Kiro IDE chat session.
        // Those are delivered by the Kiro Remote Bridge extension running
        // inside the IDE (see ide-extension/), because an IDE-owned session
        // can only be driven by the IDE's own agent client — spawning a
        // separate kiro-cli here would create a disconnected process that
        // never shows up in the IDE and loses its MCP context.
        if (event.sessionId) continue;

        if (event.type === 'user_message') {
          session.sendMessage(event.text);
        } else if (event.type === 'approval_response') {
          const targetId = event.requestId || lastApprovalRequestId;
          if (targetId) {
            applyApprovalDecision(session, config, event.decision);
          }
        }
      }
    } catch (err) {
      logError('poll loop', err);
    } finally {
      setTimeout(pollLoop, config.POLL_INTERVAL_MS);
    }
  }

  pollLoop();

  // --- Local Kiro IDE session history tracking (read-only, ~/.kiro/sessions) ---
  let sessionDetailCursor = 0;

  async function sessionScanLoop() {
    try {
      const summaries = scanSessionSummaries();
      await relay.pushLocalSessions(summaries);
    } catch (err) {
      logError('session scan loop', err);
    } finally {
      setTimeout(sessionScanLoop, config.SESSION_SCAN_INTERVAL_MS);
    }
  }

  async function sessionDetailLoop() {
    try {
      const requests = await relay.pullSessionDetailRequests(sessionDetailCursor);
      for (const req of requests) {
        sessionDetailCursor = Math.max(sessionDetailCursor, req.createdAt);
        const detail = readSessionTranscript(req.sessionId, req.sinceTimestamp);
        if (detail) {
          await relay.pushSessionDetailResult(
            req.id,
            req.sessionId,
            detail.title,
            detail.status,
            detail.messages,
            detail.truncated,
          );
        }
      }
    } catch (err) {
      logError('session detail loop', err);
    } finally {
      setTimeout(sessionDetailLoop, config.POLL_INTERVAL_MS);
    }
  }

  sessionScanLoop();
  sessionDetailLoop();

  process.on('SIGINT', () => shutdown(session));
  process.on('SIGTERM', () => shutdown(session));
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

function shutdown(session: KiroSession): void {
  session.stop();
  process.exit(0);
}

function logError(context: string, err: unknown): void {
  console.error(`[kiro-remote-agent] ${context} failed:`, err);
}

main().catch((err) => {
  console.error('[kiro-remote-agent] fatal error:', err);
  process.exit(1);
});
