import * as pty from 'node-pty';
import { appendFileSync } from 'fs';
import type { AgentConfig } from './config';

/**
 * Wraps an interactive kiro-cli process in a pseudo-terminal.
 *
 * We deliberately run kiro-cli interactively (not `--no-interactive`)
 * because the whole point of this daemon is to mirror the IDE's
 * approve/deny prompt experience to the phone — a headless one-shot
 * invocation can't pause mid-turn to ask for permission.
 *
 * Output is buffered per "turn": we consider a turn finished once the PTY
 * has been quiet for IDLE_MS_BEFORE_TURN_COMPLETE, which is a heuristic
 * (kiro-cli doesn't expose a machine-readable "turn done" signal over PTY).
 */
export class KiroSession {
  private ptyProcess: pty.IPty | null = null;
  private buffer = '';
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly onTurnOutput: (text: string) => void,
    private readonly onApprovalPromptDetected: (promptText: string) => void,
  ) {}

  start(): void {
    const args = ['chat'];
    if (this.config.KIRO_SESSION_ID) {
      args.push('--resume-id', this.config.KIRO_SESSION_ID);
    } else {
      args.push('--resume');
    }
    if (this.config.trustToolsList.length > 0) {
      args.push(`--trust-tools=${this.config.trustToolsList.join(',')}`);
    }

    this.log(`Starting: ${this.config.KIRO_CLI_BIN} ${args.join(' ')}`);

    this.ptyProcess = pty.spawn(this.config.KIRO_CLI_BIN, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: this.config.KIRO_PROJECT_DIR,
      env: {
        ...process.env,
        ...(this.config.KIRO_API_KEY ? { KIRO_API_KEY: this.config.KIRO_API_KEY } : {}),
      } as { [key: string]: string },
    });

    this.ptyProcess.onData((chunk) => this.handleChunk(chunk));
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.log(`kiro-cli exited: code=${exitCode} signal=${signal}`);
    });
  }

  /** Sends a chat message to the running session, as if typed by the user. */
  sendMessage(text: string): void {
    if (!this.ptyProcess) throw new Error('KiroSession not started');
    this.ptyProcess.write(`${text}\r`);
  }

  /** Sends raw keystrokes, used to answer an approval prompt (y/n/etc). */
  sendKeystrokes(keystrokes: string): void {
    if (!this.ptyProcess) throw new Error('KiroSession not started');
    this.ptyProcess.write(keystrokes);
  }

  stop(): void {
    this.ptyProcess?.kill();
    this.ptyProcess = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private handleChunk(chunk: string): void {
    this.log(chunk, true);
    this.buffer += chunk;

    if (this.config.approvalPromptRegex.test(stripAnsi(chunk))) {
      this.onApprovalPromptDetected(stripAnsi(this.buffer));
      // Don't clear the buffer here — the same turn's final answer text may
      // still follow after the approval is answered.
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flushTurn(), this.config.IDLE_MS_BEFORE_TURN_COMPLETE);
  }

  private flushTurn(): void {
    const text = stripAnsi(this.buffer).trim();
    this.buffer = '';
    if (text.length > 0) {
      this.onTurnOutput(text);
    }
  }

  private log(text: string, raw = false): void {
    try {
      const prefix = raw ? '' : `[kiro-remote-agent] `;
      appendFileSync(this.config.DEBUG_LOG_PATH, `${prefix}${text}\n`);
    } catch {
      // best-effort logging only
    }
  }
}

/** Strips ANSI escape sequences so text pushed to the relay/phone is clean. */
function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
