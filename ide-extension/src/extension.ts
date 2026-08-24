import * as vscode from 'vscode';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Kiro Remote Bridge
 *
 * Runs inside the Kiro IDE and delivers messages sent from the phone (via
 * kiro-remote-relay) into this window's real Kiro chat sessions.
 *
 * Why this has to be an extension rather than part of the external daemon:
 * a Kiro chat session is owned by exactly one process, and the IDE owns the
 * ones you create in the IDE. An outside process running
 * `kiro-cli chat --resume-id <id>` doesn't attach to that live session — it
 * opens a disconnected second process with its own execution context (which
 * is also why MCP auth breaks there). The IDE does expose an internal
 * command, `kiroAgent.sessions.sendPrompt`, which sends a prompt through the
 * IDE's *own* agent client — so the turn runs with the IDE's MCPs/config and
 * shows up in the real chat tab. That command is only reachable from inside
 * the IDE, hence this extension.
 */

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions');
const HOST_LABEL = 'kiro-ide';
/** Sentinel sessionId meaning "create a brand new IDE session for this prompt". */
const NEW_SESSION_SENTINEL = '__new__';
const WATCH_INTERVAL_MS = 2000;
/** How often to look for sessions in this window that should be streamed. */
const DISCOVER_INTERVAL_MS = 10000;
/** Only stream sessions touched this recently — old history isn't interesting. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound on concurrently streamed sessions, most recently active first. */
const MAX_WATCHED_SESSIONS = 12;
/** Window for matching a file entry against a message we just delivered. */
const ECHO_WINDOW_MS = 90 * 1000;

let output: vscode.OutputChannel;
let pollTimer: NodeJS.Timeout | undefined;
// Start from "now" rather than 0: on activation we only care about messages
// sent from here on. Replaying the whole backlog would re-deliver old
// messages into live chat sessions.
let cursor = Date.now();
let lastPollError: string | null = null;
let deliveredCount = 0;

interface RelayEvent {
  id: string;
  type: string;
  text?: string;
  createdAt: number;
  sessionId?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Kiro Remote Bridge');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('kiroRemoteBridge.showLog', () => output.show(true)),
    vscode.commands.registerCommand('kiroRemoteBridge.showStatus', () => {
      const { enabled, relayUrl, agentSecret } = readConfig();
      const parts = [
        `Enabled: ${enabled}`,
        `Relay: ${relayUrl || '(not set)'}`,
        `Secret: ${agentSecret ? 'set' : '(not set)'}`,
        `Workspace: ${currentWorkspacePaths().join(', ') || '(none)'}`,
        `Delivered this session: ${deliveredCount}`,
        `Streaming sessions: ${watchers.size}`,
        `Last error: ${lastPollError ?? 'none'}`,
      ];
      vscode.window.showInformationMessage(parts.join(' · '), 'Show Log').then((choice) => {
        if (choice === 'Show Log') output.show(true);
      });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kiroRemoteBridge')) {
        log('Configuration changed, restarting poll loop.');
        restartPolling(context);
      }
    }),
  );

  void maybeRunSelfTest();
  restartPolling(context);
}

let discoverTimer: NodeJS.Timeout | undefined;

/**
 * Keeps streaming in sync with the window on a timer, so sessions you drive
 * directly in the IDE reach the phone without being started from the web.
 */
function startDiscovery(): void {
  if (discoverTimer) clearInterval(discoverTimer);
  discoverTimer = setInterval(() => {
    const config = readConfig();
    if (!config.enabled || !config.relayUrl || !config.agentSecret) return;
    try {
      ensureWatchers(config);
    } catch (err) {
      log(`Discovery failed: ${describeError(err)}`);
    }
  }, DISCOVER_INTERVAL_MS);
}

/**
 * One-shot verification that this window can actually drive a chat session
 * through the IDE's own agent client. Runs only if a marker file exists
 * (created by hand), in a throwaway session, and writes what happened to a
 * result file. Used to confirm the wiring without touching real sessions.
 */
async function maybeRunSelfTest(): Promise<void> {
  const markerPath = join(homedir(), '.kiro-remote-bridge-selftest');
  const resultPath = join(homedir(), '.kiro-remote-bridge-selftest-result.txt');

  try {
    statSync(markerPath);
  } catch {
    return; // no marker, nothing to do
  }

  const lines: string[] = [`started ${new Date().toISOString()}`];
  try {
    unlinkSync(markerPath); // run at most once per marker
  } catch {
    // ignore
  }

  try {
    const commands = await vscode.commands.getCommands(true);
    lines.push(`sendPrompt command registered: ${commands.includes('kiroAgent.sessions.sendPrompt')}`);
    lines.push(`create command registered: ${commands.includes('kiroAgent.sessions.create')}`);

    const created = (await vscode.commands.executeCommand('kiroAgent.sessions.create')) as
      | { sessionId?: string }
      | undefined;
    lines.push(`created sessionId: ${created?.sessionId ?? '(none)'}`);

    if (created?.sessionId) {
      await vscode.commands.executeCommand(
        'kiroAgent.sessions.sendPrompt',
        created.sessionId,
        'selftest do kiro-remote-bridge: responda apenas "ok"',
      );
      lines.push('sendPrompt resolved without throwing');
    }
    lines.push('RESULT: PASS');
  } catch (err) {
    lines.push(`RESULT: FAIL — ${describeError(err)}`);
  }

  try {
    writeFileSync(resultPath, lines.join('\n') + '\n');
  } catch {
    // ignore
  }
  log(lines.join(' | '));
}

export function deactivate(): void {
  if (pollTimer) clearTimeout(pollTimer);
  if (discoverTimer) clearInterval(discoverTimer);
  for (const watcher of watchers.values()) clearInterval(watcher.timer);
  watchers.clear();
}

function restartPolling(context: vscode.ExtensionContext): void {
  if (pollTimer) clearTimeout(pollTimer);
  const { enabled, relayUrl, agentSecret } = readConfig();
  if (!enabled) {
    log('Disabled via kiroRemoteBridge.enabled.');
    return;
  }
  if (!relayUrl || !agentSecret) {
    log('Not configured: set kiroRemoteBridge.relayUrl and kiroRemoteBridge.agentSecret.');
    return;
  }
  log(`Polling ${relayUrl} for workspace [${currentWorkspacePaths().join(', ')}]`);
  try {
    ensureWatchers(readConfig());
  } catch (err) {
    log(`Initial discovery failed: ${describeError(err)}`);
  }
  startDiscovery();
  void pollLoop(context);
}

async function pollLoop(context: vscode.ExtensionContext): Promise<void> {
  const config = readConfig();
  if (!config.enabled || !config.relayUrl || !config.agentSecret) return;

  try {
    const events = await pull(config.relayUrl, config.agentSecret);
    lastPollError = null;
    for (const event of events) {
      // Only remote chat messages aimed at a specific local session are ours.
      // Untagged events belong to the daemon's own separate chat; approvals
      // for IDE sessions are handled by the IDE's own UI.
      if (event.type !== 'user_message' || !event.sessionId || !event.text) continue;
      await handleRemoteMessage(config, event.sessionId, event.text, event.id);
    }
  } catch (err) {
    lastPollError = describeError(err);
    log(`Poll failed: ${lastPollError}`);
  } finally {
    pollTimer = setTimeout(() => void pollLoop(context), config.pollIntervalMs);
  }
}

/**
 * Delivers one remote message into a local session, if that session belongs
 * to this window. Every Kiro window runs its own copy of this extension, so
 * we filter by workspace and then claim the message on the relay to make
 * sure exactly one window delivers it.
 */
async function handleRemoteMessage(
  config: BridgeConfig,
  sessionId: string,
  text: string,
  eventId: string,
): Promise<void> {
  const isNew = sessionId === NEW_SESSION_SENTINEL;

  // A "create a new session" request isn't tied to a workspace yet, so any
  // window could serve it; the claim below decides which one does. For an
  // existing session, only the window that owns its workspace handles it.
  if (!isNew && !sessionBelongsToThisWindow(sessionId)) return;

  const claimed = await claim(config.relayUrl, config.agentSecret, eventId);
  if (!claimed) {
    log(`Skipped ${shortId(sessionId)}: another window already claimed this message.`);
    return;
  }

  try {
    let targetSessionId = sessionId;

    if (isNew) {
      const created = (await vscode.commands.executeCommand('kiroAgent.sessions.create')) as
        | { sessionId?: string }
        | undefined;
      if (!created?.sessionId) throw new Error('o IDE não retornou o id da nova sessão');
      targetSessionId = created.sessionId;
      log(`Created new session ${shortId(targetSessionId)}`);
      // Tell the phone which session was created so it can open that thread.
      await push(config, {
        type: 'status',
        text: `session:${targetSessionId}`,
        sessionId: NEW_SESSION_SENTINEL,
      });
    }

    // Make sure the session is the one loaded in the chat panel; prompting a
    // session the window hasn't loaded yet fails, and this also means you
    // see the reply land live if you're looking at the IDE.
    await vscode.commands.executeCommand('kiroAgent.viewSession', targetSessionId);

    // Start watching before prompting so no part of the answer is missed.
    watchSessionForReplies(config, targetSessionId);

    markDelivered(targetSessionId, text);
    await vscode.commands.executeCommand('kiroAgent.sessions.sendPrompt', targetSessionId, text);
    deliveredCount += 1;
    log(`Delivered to ${shortId(targetSessionId)}: ${text.slice(0, 80)}`);
  } catch (err) {
    const message = describeError(err);
    log(`Failed to deliver to ${shortId(sessionId)}: ${message}`);
    await pushError(config, sessionId, `Falha ao entregar no Kiro IDE: ${message}`);
  }
}

// --- streaming the IDE's answer back to the phone ---

interface SessionWatcher {
  timer: NodeJS.Timeout;
  offset: number;
}

const watchers = new Map<string, SessionWatcher>();
/** Messages this window delivered, so the file echo of them isn't re-sent. */
const recentlyDelivered: { sessionId: string; text: string; at: number }[] = [];

/**
 * Keeps the set of streamed sessions in sync with what's actually active in
 * this window: every session of this workspace touched in the last day, most
 * recent first, capped so we don't tail hundreds of old files.
 *
 * This runs on a timer rather than only when the phone sends something, so a
 * session you started and are driving inside the IDE also streams to the
 * phone without you having to touch the web first.
 */
function ensureWatchers(config: BridgeConfig): void {
  const candidates = recentSessionsForThisWindow().slice(0, MAX_WATCHED_SESSIONS);
  const wanted = new Set(candidates.map((candidate) => candidate.sessionId));

  for (const [sessionId, watcher] of watchers) {
    if (!wanted.has(sessionId)) {
      clearInterval(watcher.timer);
      watchers.delete(sessionId);
      log(`Stopped watching ${shortId(sessionId)} (no longer recent).`);
    }
  }

  for (const candidate of candidates) {
    watchSessionForReplies(config, candidate.sessionId);
  }
}

/**
 * Streams a session's turns back to the phone.
 *
 * The IDE appends every turn to the session's own messages.jsonl, so we tail
 * that file from wherever it currently ends and forward new entries to the
 * relay as normal events. The phone already polls the event log, so this
 * works without depending on the daemon reading transcripts.
 */
function watchSessionForReplies(config: BridgeConfig, sessionId: string): void {
  if (watchers.has(sessionId)) return;

  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) {
    log(`Cannot watch ${shortId(sessionId)}: session directory not found.`);
    return;
  }
  const messagesPath = join(sessionDir, 'messages.jsonl');

  const watcher: SessionWatcher = {
    offset: fileSize(messagesPath), // only forward what comes after this point
    timer: setInterval(() => {
      try {
        tickWatcher(config, sessionId, messagesPath);
      } catch (err) {
        log(`Watcher error for ${shortId(sessionId)}: ${describeError(err)}`);
      }
    }, WATCH_INTERVAL_MS),
  };

  watchers.set(sessionId, watcher);
  log(`Watching ${shortId(sessionId)} (from byte ${watcher.offset}).`);
}

function tickWatcher(config: BridgeConfig, sessionId: string, messagesPath: string): void {
  const watcher = watchers.get(sessionId);
  if (!watcher) return;

  const size = fileSize(messagesPath);
  if (size < watcher.offset) {
    watcher.offset = size; // file was rewritten/truncated; resync
    return;
  }
  if (size === watcher.offset) return;

  const chunk = readFrom(messagesPath, watcher.offset, size);
  // Only advance past whole lines, so a half-written line is re-read next tick.
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) return;

  watcher.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');
  for (const line of chunk.slice(0, lastNewline).split('\n')) {
    forwardLine(config, sessionId, line);
  }
}

/** Turns one messages.jsonl line into a relay event, skipping bookkeeping entries. */
function forwardLine(config: BridgeConfig, sessionId: string, line: string): void {
  if (!line.trim()) return;
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload;
  } catch {
    return;
  }
  if (!payload) return;

  const type = String(payload.type ?? '');

  if (type === 'user') {
    const text = String(payload.content ?? '').trim();
    // A message sent from the phone is already in the event log; the IDE
    // writing it to the file would otherwise show up as a second bubble.
    if (text && !wasJustDelivered(sessionId, text)) {
      void push(config, { type: 'user_message', text, sessionId });
    }
    return;
  }

  if (type === 'assistant') {
    const text = String(payload.content ?? '').trim();
    if (text) void push(config, { type: 'assistant_message', text, sessionId });
    return;
  }

  if (type === 'tool_call') {
    const label = String(payload.title ?? payload.toolName ?? 'tool');
    void push(config, { type: 'status', text: `● ${label}`.slice(0, 490), sessionId });
  }
  // everything else (turn markers, metadata, tool_result, steering) is noise here
}

function markDelivered(sessionId: string, text: string): void {
  const now = Date.now();
  recentlyDelivered.push({ sessionId, text: text.trim(), at: now });
  while (recentlyDelivered.length > 0 && now - recentlyDelivered[0]!.at > ECHO_WINDOW_MS) {
    recentlyDelivered.shift();
  }
}

function wasJustDelivered(sessionId: string, text: string): boolean {
  const now = Date.now();
  return recentlyDelivered.some(
    (entry) =>
      entry.sessionId === sessionId && entry.text === text.trim() && now - entry.at <= ECHO_WINDOW_MS,
  );
}

/**
 * Sessions of this window's workspace that were modified recently, newest
 * first. Reads only session.json metadata, never the transcripts.
 */
function recentSessionsForThisWindow(): { sessionId: string; modifiedAt: number }[] {
  const ourPaths = currentWorkspacePaths();
  if (ourPaths.length === 0) return [];

  const found: { sessionId: string; modifiedAt: number }[] = [];
  const cutoff = Date.now() - RECENT_WINDOW_MS;

  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return [];
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

    for (const sessionId of sessionDirs) {
      const messagesPath = join(workspacePath, sessionId, 'messages.jsonl');
      let modifiedAt: number;
      try {
        modifiedAt = statSync(messagesPath).mtimeMs;
      } catch {
        continue; // no transcript yet, nothing to stream
      }
      if (modifiedAt < cutoff) continue;

      const sessionPaths = readSessionWorkspacePaths(sessionId);
      if (!sessionPaths || !sameWorkspace(sessionPaths, ourPaths)) continue;
      found.push({ sessionId, modifiedAt });
    }
  }

  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function findSessionDir(sessionId: string): string | null {
  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return null;
  }
  for (const workspaceDir of workspaceDirs) {
    const candidate = join(KIRO_SESSIONS_DIR, workspaceDir, sessionId);
    try {
      if (statSync(join(candidate, 'session.json')).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFrom(path: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A session's own session.json records the workspace it was created in. We
 * only handle sessions whose workspace matches this window exactly, so that
 * with several Kiro windows open each one only answers for its own chats.
 */
function sessionBelongsToThisWindow(sessionId: string): boolean {
  const sessionPaths = readSessionWorkspacePaths(sessionId);
  if (!sessionPaths) return false;
  return sameWorkspace(sessionPaths, currentWorkspacePaths());
}

function sameWorkspace(sessionPaths: string[], ourPaths: string[]): boolean {
  if (sessionPaths.length === 0 || ourPaths.length === 0) return false;
  return (
    sessionPaths.every((path) => ourPaths.includes(path)) &&
    ourPaths.every((path) => sessionPaths.includes(path))
  );
}

function readSessionWorkspacePaths(sessionId: string): string[] | null {
  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return null;
  }

  for (const workspaceDir of workspaceDirs) {
    const candidate = join(KIRO_SESSIONS_DIR, workspaceDir, sessionId, 'session.json');
    try {
      if (!statSync(candidate).isFile()) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      const paths = Array.isArray(parsed.workspacePaths) ? parsed.workspacePaths.map(String) : [];
      return paths;
    } catch {
      // not this workspace dir, or unreadable — keep looking
    }
  }
  return null;
}

function currentWorkspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

// --- relay calls ---

async function pull(relayUrl: string, secret: string): Promise<RelayEvent[]> {
  const url = new URL('/api/agent/pull', relayUrl);
  url.searchParams.set('since', String(cursor));
  url.searchParams.set('host', HOST_LABEL);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`pull ${res.status}`);

  const body = (await res.json()) as { events: RelayEvent[] };
  if (body.events.length > 0) {
    cursor = Math.max(cursor, ...body.events.map((event) => event.createdAt));
  }
  return body.events;
}

/** Atomic "only one window handles this message" check. */
async function claim(relayUrl: string, secret: string, eventId: string): Promise<boolean> {
  const url = new URL('/api/agent/claim', relayUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ eventId, by: HOST_LABEL }),
  });
  if (!res.ok) throw new Error(`claim ${res.status}`);
  const body = (await res.json()) as { claimed: boolean };
  return body.claimed;
}

async function pushStatus(config: BridgeConfig, sessionId: string, text: string): Promise<void> {
  await push(config, { type: 'status', text, sessionId });
}

async function pushError(config: BridgeConfig, sessionId: string, text: string): Promise<void> {
  await push(config, { type: 'error', text, sessionId });
}

async function push(config: BridgeConfig, payload: Record<string, unknown>): Promise<void> {
  try {
    const url = new URL('/api/agent/push', config.relayUrl);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentSecret}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    log(`Push failed: ${describeError(err)}`);
  }
}

// --- helpers ---

interface BridgeConfig {
  enabled: boolean;
  relayUrl: string;
  agentSecret: string;
  pollIntervalMs: number;
}

function readConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration('kiroRemoteBridge');
  return {
    enabled: config.get<boolean>('enabled', true),
    relayUrl: (config.get<string>('relayUrl', '') ?? '').replace(/\/+$/, ''),
    agentSecret: config.get<string>('agentSecret', '') ?? '',
    pollIntervalMs: config.get<number>('pollIntervalMs', 4000),
  };
}

function shortId(sessionId: string): string {
  return sessionId.length > 16 ? `${sessionId.slice(0, 16)}…` : sessionId;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function log(message: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}
