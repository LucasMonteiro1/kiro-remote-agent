import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Kiro Remote Bridge
 *
 * Runs inside the Kiro IDE and delivers messages sent from the phone (via
 * the local kiro-remote-agent hub) into this window's real Kiro chat
 * sessions.
 *
 * This connects over a plain WebSocket to ws://127.0.0.1:<HUB_PORT> on the
 * *same machine* the daemon runs on — not to any remote relay. There is no
 * more polling: every event the hub broadcasts (a message from the phone,
 * an approval decision, etc) arrives the instant it happens, pushed over
 * this one persistent connection. If the connection drops (daemon
 * restarted, laptop slept), this reconnects with a short backoff and picks
 * back up — nothing is lost since the hub keeps its own in-memory log.
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
/** Only stream sessions touched this recently — old history isn't interesting. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound on concurrently streamed sessions, most recently active first. */
const MAX_WATCHED_SESSIONS = 12;
/** How often to look for sessions in this window that should be streamed. */
const DISCOVER_INTERVAL_MS = 10000;
/** How often to tail each watched session's messages.jsonl for new lines. */
const WATCH_INTERVAL_MS = 2000;
/** Window for matching a file entry against a message we just delivered. */
const ECHO_WINDOW_MS = 90 * 1000;
/** Delay after sendPrompt before re-issuing viewSession, to work around the user's own bubble not appearing (see handleRemoteMessage). */
const VIEW_REFRESH_DELAY_MS = 400;
/** How long to wait for the IDE to confirm a dispatched approval decision actually resolved the tool call. */
const APPROVAL_CONFIRM_TIMEOUT_MS = 6000;
/** Sentinel sessionId meaning "create a brand new IDE session for this prompt". */
const NEW_SESSION_SENTINEL = '__new__';
/** Reconnect backoff bounds for the hub WebSocket connection. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let output: vscode.OutputChannel;
let hubSocket: HubSocket | undefined;
let lastError: string | null = null;
let deliveredCount = 0;

interface MessageAttachment {
  url: string;
  filename: string;
  contentType?: string;
}

interface HubEvent {
  id: string;
  type: string;
  text?: string;
  createdAt: number;
  sessionId?: string;
  requestId?: string;
  decision?: string;
  attachments?: MessageAttachment[];
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Kiro Remote Bridge');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('kiroRemoteBridge.showLog', () => output.show(true)),
    vscode.commands.registerCommand('kiroRemoteBridge.showStatus', () => {
      const config = readConfig();
      const parts = [
        `Enabled: ${config.enabled}`,
        `Hub: ${config.hubUrl || '(not set)'}`,
        `Secret: ${config.hubSecret ? 'set' : '(not set)'}`,
        `Connected: ${hubSocket?.isConnected() ?? false}`,
        `Workspace: ${currentWorkspacePaths().join(', ') || '(none)'}`,
        `Delivered this session: ${deliveredCount}`,
        `Streaming sessions: ${watchers.size}`,
        `Last error: ${lastError ?? 'none'}`,
      ];
      vscode.window.showInformationMessage(parts.join(' · '), 'Show Log').then((choice) => {
        if (choice === 'Show Log') output.show(true);
      });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kiroRemoteBridge')) {
        log('Configuration changed, reconnecting.');
        restart();
      }
    }),
  );

  restart();
}

export function deactivate(): void {
  hubSocket?.close();
  if (discoverTimer) clearInterval(discoverTimer);
  for (const watcher of watchers.values()) clearInterval(watcher.timer);
  watchers.clear();
}

function restart(): void {
  hubSocket?.close();
  const config = readConfig();
  if (!config.enabled) {
    log('Disabled via kiroRemoteBridge.enabled.');
    return;
  }
  if (!config.hubUrl || !config.hubSecret) {
    log('Not configured: set kiroRemoteBridge.hubUrl and kiroRemoteBridge.hubSecret.');
    return;
  }

  log(`Connecting to ${config.hubUrl} for workspace [${currentWorkspacePaths().join(', ')}]`);
  hubSocket = new HubSocket(config, {
    onEvent: (event) => void handleHubEvent(config, event),
    onError: (message) => {
      lastError = message;
      log(`Hub error: ${message}`);
    },
  });
  hubSocket.connect();

  try {
    ensureWatchers(config);
  } catch (err) {
    log(`Initial discovery failed: ${describeError(err)}`);
  }
  startDiscovery(config);
}

/**
 * Thin wrapper around a `ws` WebSocket that authenticates on connect and
 * reconnects with backoff on any drop. This is the extension's *only*
 * network dependency now — no more HTTP polling anywhere.
 */
class HubSocket {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private closed = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly handlers: { onEvent: (event: HubEvent) => void; onError: (message: string) => void },
  ) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.config.hubUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      ws.send(
        JSON.stringify({
          v: 1,
          kind: 'hello',
          role: 'extension',
          secret: this.config.hubSecret,
          hostLabel: HOST_LABEL,
        }),
      );
    });

    ws.on('message', (raw) => {
      let msg: { kind: string; event?: HubEvent };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.kind === 'event' && msg.event) {
        this.handlers.onEvent(msg.event);
      }
    });

    ws.on('close', (code, reason) => {
      if (this.closed) return;
      this.handlers.onError(`connection closed (${code} ${reason.toString()}), reconnecting...`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.handlers.onError(describeError(err));
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Fire-and-forget send used for push_event/resolve_approval/claim_event — matches the old push()'s "log and swallow" error handling, since nothing here blocks on a response except claim (handled separately). */
  send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /** Sends a claim_event and waits for the matching claim_result. */
  claim(eventId: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.kind === 'claim_result' && msg.eventId === eventId) {
            this.ws?.off('message', onMessage);
            resolve(!!msg.claimed);
          }
        } catch {
          // ignore
        }
      };
      this.ws.on('message', onMessage);
      this.ws.send(JSON.stringify({ v: 1, kind: 'claim_event', eventId, by: HOST_LABEL }));
      setTimeout(() => {
        this.ws?.off('message', onMessage);
        resolve(false);
      }, 5000);
    });
  }

  /** Sends a request_session_detail and resolves with the result (or rejects on error/timeout). Not currently used by this extension — session detail requests are answered directly by the daemon — kept for completeness/future use. */

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.closed) return;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

async function handleHubEvent(config: BridgeConfig, event: HubEvent): Promise<void> {
  // Untagged events belong to the daemon's own separate default chat, not
  // any local IDE session — nothing here is ours to act on.
  if (!event.sessionId) return;

  const attachments = event.attachments ?? [];
  if (event.type === 'user_message' && (event.text || attachments.length > 0)) {
    await handleRemoteMessage(config, event.sessionId, event.text ?? '', event.id, attachments);
  } else if (event.type === 'approval_response' && event.requestId && event.decision) {
    await handleRemoteApprovalResponse(config, event.sessionId, event.requestId, event.decision, event.id);
  }
}

let discoverTimer: NodeJS.Timeout | undefined;

/**
 * Keeps streaming in sync with the window on a timer, so sessions you drive
 * directly in the IDE reach the phone without being started from the web.
 * This part is still a timer (nothing to "push" here — it's a local
 * filesystem scan, not something the hub can notify us about), but it no
 * longer touches the network at all.
 */
function startDiscovery(config: BridgeConfig): void {
  if (discoverTimer) clearInterval(discoverTimer);
  discoverTimer = setInterval(() => {
    if (!config.enabled) return;
    try {
      ensureWatchers(config);
    } catch (err) {
      log(`Discovery failed: ${describeError(err)}`);
    }
  }, DISCOVER_INTERVAL_MS);
}

const HOST_LABEL = 'kiro-ide';

/**
 * Delivers one remote message into a local session, if that session belongs
 * to this window. Every Kiro window runs its own copy of this extension, so
 * we filter by workspace and then claim the message on the hub to make
 * sure exactly one window delivers it.
 */
async function handleRemoteMessage(
  config: BridgeConfig,
  sessionId: string,
  text: string,
  eventId: string,
  attachments: MessageAttachment[] = [],
): Promise<void> {
  const isNew = sessionId === NEW_SESSION_SENTINEL;

  // A "create a new session" request isn't tied to a workspace yet, so any
  // window could serve it; the claim below decides which one does. For an
  // existing session, only the window that owns its workspace handles it.
  if (!isNew && !sessionBelongsToThisWindow(sessionId)) return;

  const claimed = (await hubSocket?.claim(eventId)) ?? false;
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
      push({
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

    // Images sent from Discord are downloaded to local temp files here and
    // referenced by absolute path in the prompt, so the Kiro IDE reads them
    // with its own file tools. A download failure just falls back to the
    // text, so the user still gets a reply rather than silence.
    let prompt = text;
    if (attachments.length > 0) {
      const imagePaths = await downloadAttachments(attachments);
      if (imagePaths.length > 0) {
        prompt = composePromptWithImages(text, imagePaths);
        log(`Downloaded ${imagePaths.length} image(s) for ${shortId(targetSessionId)}`);
      } else {
        log(`No images could be downloaded for ${shortId(targetSessionId)}; sending text only.`);
      }
    }

    markDelivered(targetSessionId, prompt);
    await vscode.commands.executeCommand('kiroAgent.sessions.sendPrompt', targetSessionId, prompt);
    deliveredCount += 1;
    log(`Delivered to ${shortId(targetSessionId)}: ${prompt.slice(0, 80)}`);

    // sendPrompt only submits the turn through the ACP client — it doesn't
    // trigger the webview's "optimistic append" that draws the user's own
    // bubble (that only fires from the textbox's own submit handler, see
    // REMOTE_HOST_CAPABILITIES.optimisticUserPromptAppend in Kiro's own
    // extension). The prompt is written to messages.jsonl for real, so a
    // fresh viewSession call — which reloads the sidebar panel's transcript
    // from disk — is enough to make the bubble show up without a full IDE
    // reload. A short delay lets the write land on disk first.
    setTimeout(() => {
      void vscode.commands.executeCommand('kiroAgent.viewSession', targetSessionId).then(undefined, (err) => {
        log(`Failed to refresh session view for ${shortId(targetSessionId)}: ${describeError(err)}`);
      });
    }, VIEW_REFRESH_DELAY_MS);
  } catch (err) {
    const message = describeError(err);
    log(`Failed to deliver to ${shortId(sessionId)}: ${message}`);
    pushError(sessionId, `Falha ao entregar no Kiro IDE: ${message}`);
  }
}

/**
 * Delivers an approval decision from the phone into this window's IDE.
 *
 * The commands the IDE exposes for this (`kiroAgent.execution.trust`,
 * `.rejectAll`, `.runOrAcceptAll`) don't take a session id — they act on
 * whichever chat panel is currently focused. That makes this inherently
 * riskier than sending a prompt (which does take a session id): if two
 * approvals raced, or something changed the focused panel mid-flight, the
 * wrong session's prompt could get resolved. Three things guard against
 * that:
 *  - `approvalQueue` serializes dispatches in this window one at a time.
 *  - `pendingApprovals` is checked before dispatching, so we only act on a
 *    prompt this window actually knows is outstanding for that toolCallId.
 *  - After dispatching we `viewSession` first (so the panel is definitely
 *    the right one) and then wait for the matching `interaction_resolved`
 *    entry to actually land in that session's transcript, confirming the
 *    right prompt was the one resolved rather than assuming the command
 *    worked.
 */
async function handleRemoteApprovalResponse(
  config: BridgeConfig,
  sessionId: string,
  requestId: string,
  decision: string,
  eventId: string,
): Promise<void> {
  if (!sessionBelongsToThisWindow(sessionId)) return;

  const pending = pendingApprovals.get(requestId);
  if (!pending || pending.sessionId !== sessionId) {
    // Either this window never streamed the originating prompt, or it was
    // already resolved (e.g. answered directly in the IDE). Nothing to do.
    return;
  }

  const claimed = (await hubSocket?.claim(eventId)) ?? false;
  if (!claimed) return;

  const command = approvalCommandForDecision(decision);
  if (!command) {
    log(`Unknown approval decision "${decision}" for ${shortId(sessionId)}, ignoring.`);
    return;
  }

  approvalQueue = approvalQueue.then(() => dispatchApprovalDecision(sessionId, requestId, command));
  await approvalQueue;
}

function approvalCommandForDecision(decision: string): string | undefined {
  switch (decision) {
    case 'approve':
      return 'kiroAgent.execution.runOrAcceptAll';
    case 'approve_always':
      return 'kiroAgent.execution.trust';
    case 'deny':
      return 'kiroAgent.execution.rejectAll';
    default:
      return undefined;
  }
}

async function dispatchApprovalDecision(sessionId: string, requestId: string, command: string): Promise<void> {
  try {
    // Make sure the right panel is focused before firing a command that acts
    // on "the currently active panel" rather than a session id.
    await vscode.commands.executeCommand('kiroAgent.viewSession', sessionId);
    await vscode.commands.executeCommand(command);
    log(`Dispatched ${command} for ${shortId(sessionId)} (request ${shortId(requestId)})`);

    const confirmed = await waitForApprovalResolved(requestId, APPROVAL_CONFIRM_TIMEOUT_MS);
    if (!confirmed) {
      log(`Approval ${shortId(requestId)} on ${shortId(sessionId)} was not confirmed resolved within ${APPROVAL_CONFIRM_TIMEOUT_MS}ms.`);
      pushError(
        sessionId,
        'Não foi possível confirmar que a aprovação foi aplicada no IDE. Verifique a sessão diretamente.',
      );
    }
  } catch (err) {
    const message = describeError(err);
    log(`Failed to dispatch ${command} for ${shortId(sessionId)}: ${message}`);
    pushError(sessionId, `Falha ao aplicar aprovação no Kiro IDE: ${message}`);
  }
}

/** Polls until `pendingApprovals` no longer has this entry (cleared by the matching interaction_resolved), or times out. This one stays a short local poll — it's watching this window's own in-memory map, not the network. */
async function waitForApprovalResolved(requestId: string, timeoutMs: number): Promise<boolean> {
  const pollStep = 300;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pendingApprovals.has(requestId)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollStep));
  }
  return !pendingApprovals.has(requestId);
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
 * Tracks tool approval prompts this window has surfaced to the hub, so an
 * approval_response from the phone (which only carries the hub's own event
 * id) can be mapped back to the Kiro-side toolCallId it answers. Cleared
 * once the interaction resolves, one way or another.
 */
const pendingApprovals = new Map<string, { sessionId: string; toolCallId: string }>();
/** toolCallId -> display title, filled in from the preceding tool_call entry so the approval card can show what's being approved. */
const toolTitleByCallId = new Map<string, string>();
/**
 * Serializes approval dispatches within this window. The IDE's
 * trust/rejectAll/runOrAcceptAll commands act on "whichever chat panel is
 * currently active" rather than a specific session id, so two decisions
 * racing each other could resolve the wrong session's prompt if run
 * concurrently.
 */
let approvalQueue: Promise<void> = Promise.resolve();

/**
 * Keeps the set of streamed sessions in sync with what's actually active in
 * this window: every session of this workspace touched in the last day, most
 * recent first, capped so we don't tail hundreds of old files.
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
 * hub as normal events — the hub then pushes them straight to the phone,
 * no polling on either end.
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
        tickWatcher(sessionId, messagesPath);
      } catch (err) {
        log(`Watcher error for ${shortId(sessionId)}: ${describeError(err)}`);
      }
    }, WATCH_INTERVAL_MS),
  };

  watchers.set(sessionId, watcher);
  log(`Watching ${shortId(sessionId)} (from byte ${watcher.offset}).`);
}

function tickWatcher(sessionId: string, messagesPath: string): void {
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
    forwardLine(sessionId, line);
  }
}

/** Turns one messages.jsonl line into a hub event, skipping bookkeeping entries. */
function forwardLine(sessionId: string, line: string): void {
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
      push({ type: 'user_message', text, sessionId });
    }
    return;
  }

  if (type === 'assistant') {
    const text = String(payload.content ?? '').trim();
    if (!text) return;
    // Kiro writes both the model's internal reasoning and its actual reply as
    // `assistant` entries; `operationType` is the only thing that separates
    // them ("Reasoning" vs "Say"). Forwarding them as distinct event types is
    // what lets the phone collapse thinking the way the IDE does instead of
    // showing it as a second answer bubble.
    const isReasoning = String(payload.operationType ?? '') === 'Reasoning';
    push({
      type: isReasoning ? 'thought' : 'assistant_message',
      text,
      sessionId,
    });
    return;
  }

  if (type === 'tool_call') {
    const title = String(payload.title ?? payload.toolName ?? 'tool');
    const toolName = payload.toolName ? String(payload.toolName) : undefined;
    const kind = typeof payload.kind === 'string' ? payload.kind : undefined;
    const files = extractFileBasenames(payload.args);
    const detail = summarizeToolArgs(payload.args);
    // Kept so a later pending_interaction (which only carries the same
    // toolCallId, not a human-readable title) can show what's being approved.
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
    if (toolCallId) toolTitleByCallId.set(toolCallId, title);
    push({
      type: 'tool_call',
      title: title.slice(0, 490),
      ...(toolName ? { toolName: toolName.slice(0, 200) } : {}),
      ...(kind ? { kind } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(detail ? { detail } : {}),
      sessionId,
    });
    return;
  }

  if (type === 'pending_interaction' && payload.interactionType === 'tool_approval') {
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
    if (!toolCallId) return;
    const question = typeof payload.question === 'string' ? payload.question : 'tool_approval';
    const title = toolTitleByCallId.get(toolCallId);
    // push_event doesn't return the hub-assigned id synchronously (it's a
    // fire-and-forget send over the socket), so unlike the old HTTP
    // request/response push(), we can't learn the relay-assigned event id
    // this way anymore. Instead the hub assigns a deterministic id: we
    // generate it here and pass it through, and the hub uses it as-is
    // rather than minting its own — see hub.ts's emitEvent falling back to
    // a caller-supplied id when present.
    const relayEventId = pushApprovalRequest(question, sessionId, title);
    pendingApprovals.set(relayEventId, { sessionId, toolCallId });
    return;
  }

  if (type === 'interaction_resolved') {
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
    if (!toolCallId) return;
    // The developer answered this prompt directly in the IDE (rather than
    // from the phone) — find our matching pending entry, if any, so the
    // phone doesn't keep showing it as unresolved.
    for (const [relayEventId, entry] of pendingApprovals) {
      if (entry.toolCallId !== toolCallId) continue;
      pendingApprovals.delete(relayEventId);
      const decision = decisionFromSelectedOption(
        typeof payload.selectedOption === 'string' ? payload.selectedOption : undefined,
      );
      resolveApprovalOnHub(relayEventId, decision);
      break;
    }
  }
  // everything else (turn markers, metadata, tool_result, steering) is noise here
}

const MAX_DETAIL_LENGTH = 300;
// Argument keys worth surfacing as a tool's "detail" line, in priority
// order — the first one present wins. Covers the common tool shapes: shell
// commands, search queries/patterns, and generic file targets. Deliberately
// excludes anything that can carry large payloads (file contents, diffs,
// text to write) so `detail` always stays a short, cheap-to-send string —
// this rides along on an event that's already being pushed, so it doesn't
// add a new request, only a few dozen bytes to an existing one.
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
      return truncateDetail(value);
    }
  }

  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const joined = record.paths.filter((p) => typeof p === 'string').join(', ');
    if (joined) return truncateDetail(joined);
  }

  return undefined;
}

function truncateDetail(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
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

function decisionFromSelectedOption(optionId: string | undefined): 'approve' | 'deny' | 'approve_always' {
  switch (optionId) {
    case 'always-accept':
      return 'approve_always';
    case 'reject':
    case 'always-reject':
      return 'deny';
    default:
      return 'approve';
  }
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

// --- hub calls ---

function push(payload: Record<string, unknown>): void {
  hubSocket?.send({ v: 1, kind: 'push_event', event: payload });
}

function pushError(sessionId: string, text: string): void {
  push({ type: 'error', text, sessionId });
}

/**
 * Approval requests need their id known synchronously (to key
 * `pendingApprovals` before any response could possibly arrive), but
 * push_event over a fire-and-forget socket send doesn't give us one back
 * the way the old HTTP push() did. We generate the id here instead and
 * send it as part of the event; the hub uses a caller-supplied id when
 * present instead of minting its own (see hub.ts).
 */
function pushApprovalRequest(promptText: string, sessionId: string, toolName?: string): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  push({ id, type: 'approval_request', promptText, toolName, sessionId });
  return id;
}

function resolveApprovalOnHub(requestId: string, decision: 'approve' | 'deny' | 'approve_always'): void {
  hubSocket?.send({ v: 1, kind: 'resolve_approval', requestId, decision });
}

// --- helpers ---

interface BridgeConfig {
  enabled: boolean;
  hubUrl: string;
  hubSecret: string;
}

function readConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration('kiroRemoteBridge');
  return {
    enabled: config.get<boolean>('enabled', true),
    hubUrl: (config.get<string>('hubUrl', '') ?? '').replace(/\/+$/, ''),
    hubSecret: config.get<string>('hubSecret', '') ?? '',
  };
}

function shortId(sessionId: string): string {
  return sessionId.length > 16 ? `${sessionId.slice(0, 16)}…` : sessionId;
}

// --- image attachments ---
//
// Kept self-contained here (rather than shared with the daemon's
// src/imageDownload.ts) because this extension is a separate package that
// bundles independently and can't import from the daemon's sources. The
// logic mirrors that module: download each Discord attachment to a local
// temp file and reference the absolute path in the prompt so the Kiro IDE
// reads the image with its own file tools.

const IMAGE_TMP_DIR = join(tmpdir(), 'kiro-remote-images');
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const KNOWN_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);

async function downloadAttachments(attachments: MessageAttachment[]): Promise<string[]> {
  const results = await Promise.all(attachments.map((a) => downloadAttachment(a)));
  return results.filter((path): path is string => path !== null);
}

async function downloadAttachment(attachment: MessageAttachment): Promise<string | null> {
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    mkdirSync(IMAGE_TMP_DIR, { recursive: true });
    const path = join(IMAGE_TMP_DIR, `${randomUUID()}${safeExtension(attachment.filename, attachment.contentType)}`);
    writeFileSync(path, buffer);
    return path;
  } catch {
    return null;
  }
}

function safeExtension(filename: string, contentType?: string): string {
  const ext = extname(filename).toLowerCase();
  if (KNOWN_IMAGE_EXTENSIONS.has(ext)) return ext;
  const subtype = contentType?.split('/')[1]?.toLowerCase();
  if (subtype) {
    const fromType = `.${subtype === 'jpeg' ? 'jpg' : subtype}`;
    if (KNOWN_IMAGE_EXTENSIONS.has(fromType)) return fromType;
  }
  return '.png';
}

function composePromptWithImages(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text;
  const lines = imagePaths.map((p) => `- ${p}`).join('\n');
  const label =
    imagePaths.length === 1
      ? 'Imagem anexada (leia o arquivo local para analisá-la):'
      : 'Imagens anexadas (leia os arquivos locais para analisá-las):';
  const body = `${label}\n${lines}`;
  return text ? `${text}\n\n${body}` : body;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function log(message: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}
