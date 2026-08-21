import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { appendFileSync } from 'fs';
import type { AgentConfig } from './config';

const TERM_COLS = 200;
const TERM_ROWS = 60;

/**
 * Wraps an interactive kiro-cli process in a pseudo-terminal.
 *
 * We deliberately run kiro-cli interactively (not `--no-interactive`)
 * because the whole point of this daemon is to mirror the IDE's
 * approve/deny prompt experience to the phone — a headless one-shot
 * invocation can't pause mid-turn to ask for permission.
 *
 * kiro-cli renders a full TUI (spinners, redrawn banners, a status bar)
 * rather than printing plain scrolling text, so we can't just strip ANSI
 * codes from the raw PTY stream — it's poisoned with repeated frames and
 * cursor-movement noise. Instead we feed the raw stream into a headless
 * terminal emulator (@xterm/headless), which keeps a proper screen buffer
 * (handling clears, cursor moves, etc. the same way a real terminal would),
 * and read back the *rendered* screen content once the PTY goes idle.
 */
export class KiroSession {
  private ptyProcess: pty.IPty | null = null;
  private readonly terminal: Terminal;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastScreenText = '';
  private sawApprovalPromptThisTurn = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly onTurnOutput: (text: string) => void,
    private readonly onApprovalPromptDetected: (promptText: string) => void,
  ) {
    this.terminal = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, allowProposedApi: true });
  }

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
      cols: TERM_COLS,
      rows: TERM_ROWS,
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
    this.terminal.write(chunk);

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), this.config.IDLE_MS_BEFORE_TURN_COMPLETE);
  }

  /**
   * Called once the PTY has been quiet for IDLE_MS_BEFORE_TURN_COMPLETE.
   * Reads the currently rendered screen, checks it for an approval prompt,
   * and — if the screen actually changed since the last check — reports it
   * as this turn's output.
   */
  private onIdle(): void {
    const screenText = this.readScreenText();

    if (this.config.approvalPromptRegex.test(screenText) && !this.sawApprovalPromptThisTurn) {
      this.sawApprovalPromptThisTurn = true;
      this.onApprovalPromptDetected(screenText);
      return; // wait for the phone's decision before treating this as final turn output
    }

    if (screenText !== this.lastScreenText && screenText.trim().length > 0) {
      this.lastScreenText = screenText;
      this.sawApprovalPromptThisTurn = false;
      this.onTurnOutput(screenText);
    }
  }

  /**
   * Renders the terminal's current screen buffer (visible rows only) as
   * plain text, filtering out kiro-cli's TUI "chrome": the box-drawing
   * separator rules, the braille-character splash logo shown at startup,
   * and the bottom status bar (model/effort/cwd line + hint lines like
   * "ask a question..." / "/copy to clipboard").
   */
  private readScreenText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.terminal.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (line) lines.push(line.translateToString(true));
    }

    const filtered = lines.filter((line) => !isChromeLine(line));

    // Trim leading/trailing blank lines left behind after filtering.
    while (filtered.length > 0 && filtered[0]!.trim() === '') filtered.shift();
    while (filtered.length > 0 && filtered[filtered.length - 1]!.trim() === '') filtered.pop();

    return filtered.join('\n').trim();
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

const BOX_DRAWING_RULE = /^[─━═\s]+$/;
const STATUS_BAR_HINT =
  /^\s*(ask a question or describe a task|\/copy to clipboard|type to queue a message|Initializing)/i;
const MODEL_STATUS_LINE = /·\s*(auto|◔|⏺)/; // e.g. "kiro_default · auto · ◔ 16%   ~/project · (new-app)"
const SPLASH_BANNER_TEXT =
  /(An early release of Kiro CLI|What's new:|^\s*Tip:|https:\/\/kiro\.dev\/docs\/|requires OAuth.*Authenticate)/i;
// Braille block characters (U+2800-28FF) make up kiro-cli's startup ASCII-art
// logo. Any line where they're a large share of the non-space characters is
// splash art, not real conversation content.
const BRAILLE_RANGE = /[\u2800-\u28FF]/gu;

function isChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false; // keep blank lines, they're trimmed separately at the edges

  if (BOX_DRAWING_RULE.test(trimmed) || STATUS_BAR_HINT.test(trimmed) || MODEL_STATUS_LINE.test(trimmed)) {
    return true;
  }
  if (SPLASH_BANNER_TEXT.test(trimmed)) return true;

  const nonSpaceChars = trimmed.replace(/\s/g, '');
  if (nonSpaceChars.length === 0) return false;
  const brailleCount = (trimmed.match(BRAILLE_RANGE) ?? []).length;
  return brailleCount / nonSpaceChars.length > 0.3;
}
