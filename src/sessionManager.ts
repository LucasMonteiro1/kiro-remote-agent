import { KiroSession } from './kiroSession';
import type { AgentConfig } from './config';
import type { RelayClient } from './relayClient';
import { getSessionInfo } from './sessionScanner';

/**
 * Manages on-demand kiro-cli processes for local Kiro IDE sessions opened
 * from the phone's session viewer — as opposed to the daemon's one fixed
 * "default" chat (KIRO_PROJECT_DIR), which index.ts still owns directly.
 *
 * Each entry is spawned lazily the first time the phone sends a message
 * into that session, and torn down after IDLE_SESSION_TTL_MS of no
 * activity so we don't accumulate kiro-cli processes forever.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly config: AgentConfig,
    private readonly relay: RelayClient,
  ) {}

  /** Sends a chat message into the given session, spawning it if needed. */
  sendMessage(sessionId: string, text: string): void {
    const managed = this.getOrCreate(sessionId);
    if (!managed) return; // couldn't resolve the session's workspace; already reported an error
    managed.session.sendMessage(text);
  }

  /** Applies an approval decision to whichever session it targets. */
  applyApprovalDecision(
    sessionId: string,
    requestId: string,
    decision: 'approve' | 'deny' | 'approve_always',
  ): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return; // session isn't running (anymore); nothing to answer

    const targetId = requestId || managed.lastApprovalRequestId;
    if (!targetId) return;

    switch (decision) {
      case 'approve':
        managed.session.sendKeystrokes(this.config.APPROVE_KEYSTROKES);
        break;
      case 'approve_always':
        managed.session.sendKeystrokes(this.config.APPROVE_ALWAYS_KEYSTROKES);
        break;
      case 'deny':
        managed.session.sendKeystrokes(this.config.DENY_KEYSTROKES);
        break;
    }
  }

  /** Stops and removes any managed session idle longer than `maxIdleMs`. */
  evictIdleSessions(maxIdleMs: number): void {
    for (const [sessionId, managed] of this.sessions) {
      if (managed.session.idleForMs() > maxIdleMs) {
        managed.session.stop();
        this.sessions.delete(sessionId);
      }
    }
  }

  stopAll(): void {
    for (const managed of this.sessions.values()) {
      managed.session.stop();
    }
    this.sessions.clear();
  }

  private getOrCreate(sessionId: string): ManagedSession | null {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const info = getSessionInfo(sessionId);
    if (!info) {
      this.relay
        .pushError('Sessão não encontrada em ~/.kiro/sessions neste PC.', sessionId)
        .catch(() => {});
      return null;
    }

    const cwd = info.workspacePaths[0] ?? this.config.KIRO_PROJECT_DIR;

    if (info.status === 'in_progress') {
      // The Kiro IDE may still have this exact session open right now.
      // Running a second kiro-cli process against the same session
      // directory concurrently could race on messages.jsonl/session.json.
      // We still allow it (the user explicitly asked to be able to reply
      // from the phone), but surface a clear warning rather than silently
      // risking a conflict.
      this.relay
        .pushStatus(
          '⚠️ Esta sessão pode estar aberta no Kiro IDE agora. Responder por aqui pode gerar conflito de escrita no histórico.',
          sessionId,
        )
        .catch(() => {});
    }

    const managed: ManagedSession = { session: null as unknown as KiroSession, lastApprovalRequestId: null };

    const session = new KiroSession(
      this.config,
      { label: sessionId, cwd, resumeSessionId: sessionId },
      (turnText) => {
        this.relay.pushAssistantMessage(turnText, sessionId).catch(() => {});
      },
      (promptText) => {
        this.relay
          .pushApprovalRequest(promptText, sessionId)
          .then((requestId) => {
            managed.lastApprovalRequestId = requestId;
          })
          .catch(() => {});
      },
      (noticeText) => {
        this.relay.pushError(noticeText, sessionId).catch(() => {});
      },
      () => {
        // kiro-cli exited on its own (crash, --resume-id no longer valid,
        // etc). Drop it from the map so the next message respawns fresh.
        this.sessions.delete(sessionId);
      },
    );

    managed.session = session;
    this.sessions.set(sessionId, managed);
    session.start();
    this.relay.pushStatus(`Sessão retomada em ${cwd}.`, sessionId).catch(() => {});

    return managed;
  }
}

interface ManagedSession {
  session: KiroSession;
  lastApprovalRequestId: string | null;
}
