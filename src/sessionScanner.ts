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

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
