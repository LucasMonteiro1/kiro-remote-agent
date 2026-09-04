import 'dotenv/config';
import { loadConfig } from './config';
import { Hub } from './hub';
import { DiscordBot } from './discordBot';
import { KiroSession } from './kiroSession';
import { scanSessionSummaries } from './sessionScanner';
import type { HubEvent } from './hubProtocol';

async function main() {
  const config = loadConfig();
  const hub = new Hub(config);
  const discord = new DiscordBot(config, hub);

  // requestId -> resolve callback, used to route an approval decision from
  // Discord back into a "send keystrokes to the PTY" action, for the
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
  await discord.start();

  // Events for the daemon's own default chat arrive as direct hub
  // callbacks — no network hop, no polling, no delay.
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
  // Only used to label newly created Discord threads with a session's real
  // title instead of a raw id — no longer broadcast anywhere.
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

  process.on('SIGINT', () => shutdown(session, hub, discord));
  process.on('SIGTERM', () => shutdown(session, hub, discord));
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

function shutdown(session: KiroSession, hub: Hub, discord: DiscordBot): void {
  session.stop();
  hub.stop();
  void discord.stop().finally(() => process.exit(0));
}

function logError(context: string, err: unknown): void {
  console.error(`[kiro-remote-agent] ${context} failed:`, err);
}

main().catch((err) => {
  console.error('[kiro-remote-agent] fatal error:', err);
  process.exit(1);
});
