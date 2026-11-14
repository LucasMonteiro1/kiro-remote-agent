import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions');
const MAX_TITLE_LENGTH = 200;
/**
 * Upper bound on how many session summaries are kept, most recently
 * modified first. ~/.kiro/sessions accumulates history across every project
 * on the machine (it can reach thousands of sessions), and this cache is
 * only used to label Discord threads — there's no reason to hold the whole
 * backlog in memory.
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

/**
 * Scans ~/.kiro/sessions/*&#47;*&#47;session.json for lightweight metadata about
 * every Kiro IDE session on this machine (local IDE sessions only — this
 * daemon's own kiro-cli session is separate and not included here).
 *
 * This only reads the small session.json files, never the (potentially
 * huge) messages.jsonl transcripts, so it stays cheap even with thousands
 * of historical sessions on disk. The result is used only to label Discord
 * threads with a real session title instead of a raw id.
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
        // Workflow step sessions are internal to a parent session; they never
        // get a Discord thread, so don't let them take slots in this cache.
        if (isChildSessionMeta(parsed)) continue;
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

  // Most recently touched first, capped to MAX_SYNCED_SESSIONS.
  summaries.sort((a, b) => (b.lastModifiedAt ?? '').localeCompare(a.lastModifiedAt ?? ''));
  return summaries.slice(0, MAX_SYNCED_SESSIONS);
}

/**
 * A session spawned by another session (a workflow step, a sub-agent) and
 * not started by the user. Kiro marks those with `rootConversationId`
 * pointing at the parent and, for workflow steps, `_meta.kiro.workflow`.
 */
export function isChildSessionMeta(parsed: Record<string, unknown>): boolean {
  const root = parsed.rootConversationId;
  if (typeof root === 'string' && root && root !== parsed.id) return true;
  const meta = parsed._meta as { kiro?: { workflow?: unknown } } | undefined;
  return Boolean(meta && typeof meta === 'object' && meta.kiro?.workflow);
}

/** sessionId -> whether it's a child session. The flag never changes for a session, so it's cached forever. */
const childSessionCache = new Map<string, boolean>();

/**
 * Whether `sessionId` is a child (workflow step / sub-agent) session, read
 * from its session.json. Unknown or unreadable sessions are treated as
 * top-level and not cached, so a session whose session.json hasn't landed
 * yet gets re-checked on the next event.
 */
export function isChildSession(sessionId: string): boolean {
  const cached = childSessionCache.get(sessionId);
  if (cached !== undefined) return cached;

  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return false;
  }
  for (const workspaceDir of workspaceDirs) {
    try {
      const raw = readFileSync(join(KIRO_SESSIONS_DIR, workspaceDir, sessionId, 'session.json'), 'utf8');
      const result = isChildSessionMeta(JSON.parse(raw) as Record<string, unknown>);
      childSessionCache.set(sessionId, result);
      return result;
    } catch {
      // Not in this workspace dir; keep looking.
    }
  }
  return false;
}

/** sessionId -> workspacePaths. Kiro fixes them when the session is created, so they're cached forever. */
const workspacePathsCache = new Map<string, string[]>();

/**
 * The folders a session was created with, read from its session.json, or
 * null if the session isn't on disk (yet). Used by the hub to decide which
 * IDE window owns a session when several are open.
 */
export function sessionWorkspacePaths(sessionId: string): string[] | null {
  const cached = workspacePathsCache.get(sessionId);
  if (cached) return cached;

  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return null;
  }
  for (const workspaceDir of workspaceDirs) {
    try {
      const raw = readFileSync(join(KIRO_SESSIONS_DIR, workspaceDir, sessionId, 'session.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const paths = Array.isArray(parsed.workspacePaths) ? parsed.workspacePaths.map(String) : [];
      workspacePathsCache.set(sessionId, paths);
      return paths;
    } catch {
      // Not in this workspace dir; keep looking.
    }
  }
  return null;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
