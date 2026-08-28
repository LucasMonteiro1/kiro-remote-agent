import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions');
const MAX_MESSAGES_PER_SESSION = 400; // cap payload size when reading a transcript
const MAX_TITLE_LENGTH = 200;
/**
 * Upper bound on how many session summaries get synced to the relay, most
 * recently modified first. Without this, the snapshot grows forever as
 * ~/.kiro/sessions accumulates history across every project on the
 * machine (it reached ~1,500 sessions / ~580KB after a few months) — and
 * that whole payload gets re-sent on every daemon push (every
 * SESSION_SCAN_INTERVAL_MS) and re-downloaded on every phone poll (every
 * 20s while the sessions list is open), which is what was driving up
 * Vercel's Fast Origin Transfer usage.
 */
const MAX_SYNCED_SESSIONS = 50;

export interface SessionSummary {
  id: string;
  title: string;
  status: string | null;
  workspacePaths: string[];
  modelId?: string;
  agentMode?: string;
  createdAt?: string;
  lastModifiedAt?: string;
}

export interface SessionMessage {
  type: string;
  timestamp: string;
  text: string;
  /**
   * Only present for `type: "assistant"`. Kiro tags the model's internal
   * reasoning as `"Reasoning"` and the reply meant to be read as `"Say"`;
   * both are written as `assistant` entries, so this is the only thing that
   * distinguishes a thought from an answer in a transcript.
   */
  operationType?: string;
  /** Only present for `type: "tool_call"`: e.g. "search", "read", "execute". */
  kind?: string;
  /** Only present for `type: "tool_call"`: basenames of files it targeted. */
  files?: string[];
  /** Only present for `type: "tool_call"`: compact summary of its args (command, query, etc). */
  detail?: string;
}

/**
 * Scans ~/.kiro/sessions/*&#47;*&#47;session.json for lightweight metadata about
 * every Kiro IDE session on this machine (local IDE sessions only — this
 * daemon's own kiro-cli session is separate and not included here).
 *
 * This only reads the small session.json files, never the (potentially
 * huge) messages.jsonl transcripts, so it stays cheap even with thousands
 * of historical sessions on disk.
 */
export function scanSessionSummaries(): SessionSummary[] {
  const summaries: SessionSummary[] = [];

  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return summaries; // ~/.kiro/sessions doesn't exist on this machine
  }

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = join(KIRO_SESSIONS_DIR, workspaceDir);
    let sessionDirs: string[];
    try {
      if (!statSync(workspacePath).isDirectory()) continue;
      sessionDirs = readdirSync(workspacePath);
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      const sessionJsonPath = join(workspacePath, sessionDir, 'session.json');
      try {
        const raw = readFileSync(sessionJsonPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        summaries.push({
          id: String(parsed.id ?? sessionDir),
          title: truncate(String(parsed.title ?? ''), MAX_TITLE_LENGTH),
          status: typeof parsed.status === 'string' ? parsed.status : null,
          workspacePaths: Array.isArray(parsed.workspacePaths)
            ? parsed.workspacePaths.map(String)
            : [],
          modelId: typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
          agentMode: typeof parsed.agentMode === 'string' ? parsed.agentMode : undefined,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
          lastModifiedAt: typeof parsed.lastModifiedAt === 'string' ? parsed.lastModifiedAt : undefined,
        });
      } catch {
        // Not a session directory, or session.json missing/corrupt — skip it.
      }
    }
  }

  // Most recently touched first, capped to MAX_SYNCED_SESSIONS — old
  // sessions from months ago aren't worth their share of every sync/poll
  // payload when they're already effectively archived.
  summaries.sort((a, b) => (b.lastModifiedAt ?? '').localeCompare(a.lastModifiedAt ?? ''));
  return summaries.slice(0, MAX_SYNCED_SESSIONS);
}

/**
 * Finds a session's directory by its id (searching across all workspace
 * subdirectories, since we don't know which workspace it belongs to from
 * the id alone) and reads its messages.jsonl into a compact, renderable
 * list of chat entries.
 *
 * `sinceTimestamp` (an ISO timestamp) turns this into a tail read: only
 * messages strictly after it are returned. The phone re-requests this on a
 * timer while a session's chat screen is open (see SessionDetailView's
 * TAIL_INTERVAL_MS), so without this filter every tail tick re-reads and
 * re-uploads the whole transcript (up to MAX_MESSAGES_PER_SESSION entries,
 * tens/hundreds of KB) even when nothing new was said — that's what was
 * driving up egress on the relay's Postgres (Neon) instance.
 */
export function readSessionTranscript(
  sessionId: string,
  sinceTimestamp?: string,
): {
  title: string;
  status: string | null;
  messages: SessionMessage[];
  truncated: boolean;
} | null {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return null;

  let title = '';
  let status: string | null = null;
  try {
    const sessionJson = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
    title = String(sessionJson.title ?? '');
    status = typeof sessionJson.status === 'string' ? sessionJson.status : null;
  } catch {
    // best-effort; title/status stay empty
  }

  let rawLines: string[];
  try {
    const content = readFileSync(join(sessionDir, 'messages.jsonl'), 'utf8');
    rawLines = content.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return { title, status, messages: [], truncated: false };
  }

  const allMessages: SessionMessage[] = [];
  for (const line of rawLines) {
    const message = parseMessageLine(line);
    if (message) allMessages.push(message);
  }

  if (sinceTimestamp) {
    const tail = allMessages.filter((message) => message.timestamp > sinceTimestamp);
    return { title, status, messages: tail, truncated: false };
  }

  const truncated = allMessages.length > MAX_MESSAGES_PER_SESSION;
  const messages = truncated ? allMessages.slice(-MAX_MESSAGES_PER_SESSION) : allMessages;

  return { title, status, messages, truncated };
}

/**
 * Reads a session's own session.json (workspacePaths + current status),
 * used when the daemon needs to spawn/resume a kiro-cli process for a
 * specific session id opened from the phone's session viewer.
 */
export function getSessionInfo(
  sessionId: string,
): { workspacePaths: string[]; status: string | null } | null {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return null;

  try {
    const parsed = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    return {
      workspacePaths: Array.isArray(parsed.workspacePaths) ? parsed.workspacePaths.map(String) : [],
      status: typeof parsed.status === 'string' ? parsed.status : null,
    };
  } catch {
    return null;
  }
}

function findSessionDir(sessionId: string): string | null {
  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return null;
  }

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = join(KIRO_SESSIONS_DIR, workspaceDir);
    let sessionDirs: string[];
    try {
      if (!statSync(workspacePath).isDirectory()) continue;
      sessionDirs = readdirSync(workspacePath);
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      if (sessionDir === sessionId) {
        return join(workspacePath, sessionDir);
      }
    }
  }

  return null;
}

/**
 * Renders a single messages.jsonl line into a compact chat entry, or
 * returns null for entry types not worth surfacing (steering inclusion,
 * usage summaries, raw session_start system prompt, etc).
 */
function parseMessageLine(line: string): SessionMessage | null {
  let entry: { timestamp?: string; payload?: Record<string, unknown> };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const payload = entry.payload;
  if (!payload) return null;
  const type = String(payload.type ?? '');
  const timestamp = entry.timestamp ?? '';

  switch (type) {
    case 'user':
      return { type, timestamp, text: String(payload.content ?? '') };
    case 'assistant': {
      const operationType =
        typeof payload.operationType === 'string' ? payload.operationType : undefined;
      return {
        type,
        timestamp,
        text: String(payload.content ?? ''),
        ...(operationType ? { operationType } : {}),
      };
    }
    case 'tool_call': {
      const toolName = String(payload.toolName ?? payload.actionType ?? 'tool');
      const title = payload.title ? String(payload.title) : toolName;
      const kind = typeof payload.kind === 'string' ? payload.kind : undefined;
      const files = extractFileBasenames(payload.args);
      const detail = summarizeToolArgs(payload.args);
      return {
        type,
        timestamp,
        text: title,
        ...(kind ? { kind } : {}),
        ...(files.length > 0 ? { files } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    case 'tool_result': {
      // tool_result content can be large (file contents, search results);
      // keep only a short preview so transcripts stay compact.
      const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);
      return { type, timestamp, text: truncate(content, 300) };
    }
    default:
      return null; // skip turn_start/turn_end/session_metadata/steering_inclusion/etc
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const MAX_DETAIL_LENGTH = 300;
// Argument keys worth surfacing as a tool's "detail" line, in priority
// order — the first one present wins. Covers the common tool shapes: shell
// commands, search queries/patterns, and generic file targets. Deliberately
// excludes anything that can carry large payloads (file contents, diffs,
// text to write) so `detail` always stays a short, cheap-to-store string.
const DETAIL_ARG_KEYS = [
  'command',
  'query',
  'regex',
  'pattern',
  'url',
  'path',
  'filePath',
  'targetFile',
];

/**
 * Builds a compact one-line summary of a tool_call's args — the shell
 * command run, the search query used, the URL fetched, etc. — the way the
 * IDE reveals a tool's detail when you expand its row in a "Running N
 * tools" group. Only pulls from a short allow-list of scalar arg keys, so
 * this can't accidentally include a large payload (file contents a
 * fs_write call was about to write, a big diff, etc).
 */
function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;

  for (const key of DETAIL_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return truncate(value, MAX_DETAIL_LENGTH);
    }
  }

  // Multi-file tools (read_files, etc) carry a `paths` array instead of a
  // single `path` — join a few of them so the detail still says something.
  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const joined = record.paths.filter((p) => typeof p === 'string').join(', ');
    if (joined) return truncate(joined, MAX_DETAIL_LENGTH);
  }

  return undefined;
}

/**
 * Pulls file basenames out of a tool_call's args, the way the IDE tags a
 * "Read Files"/"Read File" row with small file-name chips. Only looks at
 * the arg shapes actually used by file-oriented tools (`path`, `paths`,
 * `filePath`, `targetFile`) — anything else (grep queries, shell commands)
 * has no natural "file" to show and is left without badges.
 */
function extractFileBasenames(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const candidates: unknown[] = [
    record.path,
    record.filePath,
    record.targetFile,
    record.sourcePath,
    record.destinationPath,
    ...(Array.isArray(record.paths) ? record.paths : []),
  ];

  const basenames: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const basename = candidate.split(/[/\\]/).pop();
    if (basename) basenames.push(basename);
  }
  return basenames.slice(0, 8);
}
