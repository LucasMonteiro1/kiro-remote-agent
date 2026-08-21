import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { appendFileSync } from 'fs';
import type { AgentConfig } from './config';

const TERM_COLS = 200;
const TERM_ROWS = 60;

/**
 * Everything KiroSession needs to spawn and identify its underlying
 * kiro-cli process. Split out from AgentConfig so the same class can be
 * used both for the daemon's one fixed "default" chat and for on-demand
 * sessions the phone opens from the session viewer (each with its own
 * working directory and --resume-id).
 */
export interface KiroSessionOptions {
  /** Label used only in debug log lines, e.g. "default" or the session id. */
  label: string;
  cwd: string;
  /** If set, resumes this specific session id; otherwise resumes the most recent session in `cwd`. */
  resumeSessionId?: string;
}

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
 * (handling clears, cursor moves, etc. the same way a real terminal would).
 *
 * Once the PTY goes idle we read back the *rendered* screen and diff it
 * against the previously rendered screen (finding the overlap between the
 * old screen's tail and the new screen's head, since kiro-cli's TUI mostly
 * appends/scrolls rather than clearing) so only genuinely new lines are
 * reported as this turn's output — otherwise every idle tick would resend
 * the whole visible conversation history.
 */
export class KiroSession {
  private ptyProcess: pty.IPty | null = null;
  private readonly terminal: Terminal;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastScreenLines: string[] = [];
  private lastSystemNotice: string | null = null;
  private hasSyncedInitialScreen = false;
  private sawApprovalPromptThisTurn = false;
  private lastActivityAt = Date.now();

  constructor(
    private readonly config: AgentConfig,
    private readonly options: KiroSessionOptions,
    private readonly onTurnOutput: (text: string) => void,
    private readonly onApprovalPromptDetected: (promptText: string) => void,
    private readonly onSystemNotice: (text: string) => void,
    private readonly onExit?: (exitCode: number) => void,
  ) {
    this.terminal = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, allowProposedApi: true });
  }

  start(): void {
    const args = ['chat'];
    if (this.options.resumeSessionId) {
      args.push('--resume-id', this.options.resumeSessionId);
    } else {
      args.push('--resume');
    }
    if (this.config.trustToolsList.length > 0) {
      args.push(`--trust-tools=${this.config.trustToolsList.join(',')}`);
    }

    this.log(`[${this.options.label}] Starting: ${this.config.KIRO_CLI_BIN} ${args.join(' ')} (cwd=${this.options.cwd})`);

    this.ptyProcess = pty.spawn(this.config.KIRO_CLI_BIN, args, {
      name: 'xterm-color',
      cols: TERM_COLS,
      rows: TERM_ROWS,
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.config.KIRO_API_KEY ? { KIRO_API_KEY: this.config.KIRO_API_KEY } : {}),
      } as { [key: string]: string },
    });

    this.ptyProcess.onData((chunk) => this.handleChunk(chunk));
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.log(`[${this.options.label}] kiro-cli exited: code=${exitCode} signal=${signal}`);
      this.onExit?.(exitCode);
    });
  }

  /** Sends a chat message to the running session, as if typed by the user. */
  sendMessage(text: string): void {
    if (!this.ptyProcess) throw new Error('KiroSession not started');
    this.lastActivityAt = Date.now();
    this.ptyProcess.write(`${text}\r`);
  }

  /** Sends raw keystrokes, used to answer an approval prompt (y/n/etc). */
  sendKeystrokes(keystrokes: string): void {
    if (!this.ptyProcess) throw new Error('KiroSession not started');
    this.lastActivityAt = Date.now();
    this.ptyProcess.write(keystrokes);
  }

  /** Milliseconds since the last message/keystroke sent into this session. */
  idleForMs(): number {
    return Date.now() - this.lastActivityAt;
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
   * Reads the currently rendered screen, checks it for an approval prompt
   * or a system notice (auth/quota/MCP issues), and reports whatever is
   * genuinely new since the last check.
   */
  private onIdle(): void {
    const { contentLines, noticeText } = this.readScreen();
    const screenText = contentLines.join('\n').trim();

    if (this.config.approvalPromptRegex.test(screenText) && !this.sawApprovalPromptThisTurn) {
      this.sawApprovalPromptThisTurn = true;
      this.onApprovalPromptDetected(screenText);
      return; // wait for the phone's decision before treating this as final turn output
    }

    if (!this.hasSyncedInitialScreen) {
      // First read after (re)starting: this is likely a resumed session
      // whose whole history is on screen. Sync our baseline without
      // treating it as a brand-new message, so restarting the daemon
      // doesn't replay old conversation history to the phone.
      this.hasSyncedInitialScreen = true;
      this.lastScreenLines = contentLines;
      this.lastSystemNotice = noticeText;
      return;
    }

    if (noticeText && noticeText !== this.lastSystemNotice) {
      this.onSystemNotice(noticeText);
    }
    this.lastSystemNotice = noticeText;

    const newLines = diffNewLines(this.lastScreenLines, contentLines);
    this.lastScreenLines = contentLines;
    this.sawApprovalPromptThisTurn = false;

    const newText = newLines.join('\n').trim();
    if (newText.length > 0) {
      this.lastActivityAt = Date.now();
      this.onTurnOutput(newText);
    }
  }

  /**
   * Renders the terminal's current screen buffer (visible rows only),
   * splitting it into:
   * - contentLines: actual conversation text, with kiro-cli's TUI "chrome"
   *   filtered out (box-drawing rules, splash logo, status bar, spinners)
   * - noticeText: a system notice line if one is currently showing (auth
   *   required, MCP failures, quota reached), or null
   */
  private readScreen(): { contentLines: string[]; noticeText: string | null } {
    const buffer = this.terminal.buffer.active;
    const rawLines: string[] = [];
    for (let i = 0; i < this.terminal.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (line) rawLines.push(line.translateToString(true));
    }

    let noticeText: string | null = null;
    const contentLines: string[] = [];
    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (trimmed === '') {
        contentLines.push('');
        continue;
      }
      const noticeMatch = SYSTEM_NOTICE.exec(trimmed);
      if (noticeMatch) {
        noticeText = trimmed;
        continue; // notices are surfaced separately, not as assistant text
      }
      if (!isChromeLine(trimmed)) {
        contentLines.push(trimmed);
      }
    }

    // Trim leading/trailing blank lines left behind after filtering.
    while (contentLines.length > 0 && contentLines[0] === '') contentLines.shift();
    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();

    return { contentLines, noticeText };
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

/**
 * Returns the lines of `curr` that are genuinely new compared to `prev`,
 * by finding the largest overlap between prev's tail and curr's head
 * (kiro-cli's TUI mostly appends new content below existing lines, and
 * old lines scroll off the top once the screen fills up).
 */
function diffNewLines(prev: string[], curr: string[]): string[] {
  const maxOverlap = Math.min(prev.length, curr.length);
  for (let k = maxOverlap; k > 0; k--) {
    const prevTail = prev.slice(prev.length - k);
    const currHead = curr.slice(0, k);
    if (arraysEqual(prevTail, currHead)) {
      return curr.slice(k);
    }
  }
  return curr;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

const BOX_DRAWING_RULE = /^[─━═\s]+$/;
const STATUS_BAR_HINT =
  /^\s*(ask a question or describe a task|\/copy to clipboard|type to queue a message|Initializing|Kiro is working|Type to steer|Ctrl\+S to queue)/i;
const MODEL_STATUS_LINE = /·\s*(auto|◔|⏺)/; // e.g. "kiro_default · auto · ◔ 16%   ~/project · (new-app)"
const SPINNER_LINE = /^(Thinking\.\.\.|esc to cancel)/i;
const SPLASH_BANNER_TEXT =
  /(An early release of Kiro CLI|What's new:|^\s*Tip:|https:\/\/kiro\.dev\/docs\/)/i;
// System-level notices (auth required, MCP issues, quota) shown in the
// status area — surfaced separately via onSystemNotice, not as chat text.
const SYSTEM_NOTICE = /(requires OAuth|MCP failures|monthly usage limit has been reached)/i;
// Braille block characters (U+2800-28FF) make up kiro-cli's startup ASCII-art
// logo. Any line where they're a large share of the non-space characters is
// splash art, not real conversation content.
const BRAILLE_RANGE = /[\u2800-\u28FF]/gu;

function isChromeLine(trimmed: string): boolean {
  if (
    BOX_DRAWING_RULE.test(trimmed) ||
    STATUS_BAR_HINT.test(trimmed) ||
    MODEL_STATUS_LINE.test(trimmed) ||
    SPINNER_LINE.test(trimmed) ||
    SPLASH_BANNER_TEXT.test(trimmed) ||
    trimmed === 'Ctrl+y: Authenticate'
  ) {
    return true;
  }

  const nonSpaceChars = trimmed.replace(/\s/g, '');
  if (nonSpaceChars.length === 0) return false;
  const brailleCount = (trimmed.match(BRAILLE_RANGE) ?? []).length;
  return brailleCount / nonSpaceChars.length > 0.3;
}
