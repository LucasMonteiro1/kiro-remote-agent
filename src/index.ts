import 'dotenv/config';
import { loadConfig } from './config';
import { RelayClient } from './relayClient';
import { KiroSession } from './kiroSession';

async function main() {
  const config = loadConfig();
  const relay = new RelayClient(config);

  // requestId -> resolve callback, used to route an approval decision from
  // the phone back into a "send keystrokes to the PTY" action.
  const pendingApprovals = new Map<string, () => void>();
  let lastApprovalRequestId: string | null = null;

  const session = new KiroSession(
    config,
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
  );

  session.start();
  await relay.pushStatus(`Agente conectado em ${config.HOST_LABEL}.`).catch(() => {});

  async function pollLoop() {
    try {
      const events = await relay.pull();
      for (const event of events) {
        if (event.type === 'user_message') {
          session.sendMessage(event.text);
        } else if (event.type === 'approval_response') {
          const targetId = event.requestId || lastApprovalRequestId;
          if (targetId) {
            applyApprovalDecision(session, config, event.decision);
            pendingApprovals.delete(targetId);
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
