import 'dotenv/config';
import { loadConfig } from './config';
import { RelayClient } from './relayClient';
import { KiroSession } from './kiroSession';
import { SessionManager } from './sessionManager';
import { scanSessionSummaries, readSessionTranscript } from './sessionScanner';

const IDLE_SESSION_TTL_MS = 30 * 60 * 1000; // stop on-demand kiro-cli processes after 30 min of no activity
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const relay = new RelayClient(config);
  const sessionManager = new SessionManager(config, relay);

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
        // No sessionId means the default chat (the daemon's fixed
        // KIRO_PROJECT_DIR session); a concrete sessionId targets an
        // on-demand session opened from the phone's session viewer.
        if (event.type === 'user_message') {
          if (event.sessionId) {
            sessionManager.sendMessage(event.sessionId, event.text);
          } else {
            session.sendMessage(event.text);
          }
        } else if (event.type === 'approval_response') {
          if (event.sessionId) {
            sessionManager.applyApprovalDecision(event.sessionId, event.requestId, event.decision);
          } else {
            const targetId = event.requestId || lastApprovalRequestId;
            if (targetId) {
              applyApprovalDecision(session, config, event.decision);
            }
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

  setInterval(() => sessionManager.evictIdleSessions(IDLE_SESSION_TTL_MS), IDLE_SWEEP_INTERVAL_MS);

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
        const detail = readSessionTranscript(req.sessionId);
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

  process.on('SIGINT', () => shutdown(session, sessionManager));
  process.on('SIGTERM', () => shutdown(session, sessionManager));
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

function shutdown(session: KiroSession, sessionManager: SessionManager): void {
  session.stop();
  sessionManager.stopAll();
  process.exit(0);
}

function logError(context: string, err: unknown): void {
  console.error(`[kiro-remote-agent] ${context} failed:`, err);
}

main().catch((err) => {
  console.error('[kiro-remote-agent] fatal error:', err);
  process.exit(1);
});
