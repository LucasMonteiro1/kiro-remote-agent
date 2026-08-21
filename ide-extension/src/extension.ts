import * as vscode from 'vscode';
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
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
  if (!sessionBelongsToThisWindow(sessionId)) return;

  const claimed = await claim(config.relayUrl, config.agentSecret, eventId);
  if (!claimed) {
    log(`Skipped ${shortId(sessionId)}: another window already claimed this message.`);
    return;
  }

  try {
    // Make sure the session is the one loaded in the chat panel; prompting a
    // session the window hasn't loaded yet fails, and this also means you
    // see the reply land live if you're looking at the IDE.
    await vscode.commands.executeCommand('kiroAgent.viewSession', sessionId);
    await vscode.commands.executeCommand('kiroAgent.sessions.sendPrompt', sessionId, text);
    deliveredCount += 1;
    log(`Delivered to ${shortId(sessionId)}: ${text.slice(0, 80)}`);
    await pushStatus(config, sessionId, 'Mensagem entregue na sessão do Kiro IDE.');
  } catch (err) {
    const message = describeError(err);
    log(`Failed to deliver to ${shortId(sessionId)}: ${message}`);
    await pushError(config, sessionId, `Falha ao entregar no Kiro IDE: ${message}`);
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
  const ourPaths = currentWorkspacePaths();
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
