import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions');
const MAX_MESSAGES_PER_SESSION = 400; // cap payload size when reading a transcript
const MAX_TITLE_LENGTH = 200;

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

  return summaries;
}

/**
 * Finds a session's directory by its id (searching across all workspace
 * subdirectories, since we don't know which workspace it belongs to from
 * the id alone) and reads its messages.jsonl into a compact, renderable
 * list of chat entries.
 */
export function readSessionTranscript(sessionId: string): {
  title: string;
  messages: SessionMessage[];
  truncated: boolean;
} | null {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return null;

  let title = '';
  try {
    const sessionJson = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
    title = String(sessionJson.title ?? '');
  } catch {
    // best-effort; title stays empty
  }

  let rawLines: string[];
  try {
    const content = readFileSync(join(sessionDir, 'messages.jsonl'), 'utf8');
    rawLines = content.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return { title, messages: [], truncated: false };
  }

  const allMessages: SessionMessage[] = [];
  for (const line of rawLines) {
    const message = parseMessageLine(line);
    if (message) allMessages.push(message);
  }

  const truncated = allMessages.length > MAX_MESSAGES_PER_SESSION;
  const messages = truncated ? allMessages.slice(-MAX_MESSAGES_PER_SESSION) : allMessages;

  return { title, messages, truncated };
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
    case 'assistant':
      return { type, timestamp, text: String(payload.content ?? '') };
    case 'tool_call': {
      const toolName = String(payload.toolName ?? payload.actionType ?? 'tool');
      const title = payload.title ? String(payload.title) : toolName;
      return { type, timestamp, text: title };
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
