"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
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
const KIRO_SESSIONS_DIR = (0, path_1.join)((0, os_1.homedir)(), '.kiro', 'sessions');
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
/** Delay after sendPrompt before re-issuing viewSession, to work around the user's own bubble not appearing (see handleRemoteMessage). */
const VIEW_REFRESH_DELAY_MS = 400;
/** How long to wait for the IDE to confirm a dispatched approval decision actually resolved the tool call. */
const APPROVAL_CONFIRM_TIMEOUT_MS = 6000;
let output;
let pollTimer;
// Start from "now" rather than 0: on activation we only care about messages
// sent from here on. Replaying the whole backlog would re-deliver old
// messages into live chat sessions.
let cursor = Date.now();
let lastPollError = null;
let deliveredCount = 0;
function activate(context) {
    output = vscode.window.createOutputChannel('Kiro Remote Bridge');
    context.subscriptions.push(output);
    context.subscriptions.push(vscode.commands.registerCommand('kiroRemoteBridge.showLog', () => output.show(true)), vscode.commands.registerCommand('kiroRemoteBridge.showStatus', () => {
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
            if (choice === 'Show Log')
                output.show(true);
        });
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('kiroRemoteBridge')) {
            log('Configuration changed, restarting poll loop.');
            restartPolling(context);
        }
    }));
    void maybeRunSelfTest();
    restartPolling(context);
}
let discoverTimer;
/**
 * Keeps streaming in sync with the window on a timer, so sessions you drive
 * directly in the IDE reach the phone without being started from the web.
 */
function startDiscovery() {
    if (discoverTimer)
        clearInterval(discoverTimer);
    discoverTimer = setInterval(() => {
        const config = readConfig();
        if (!config.enabled || !config.relayUrl || !config.agentSecret)
            return;
        try {
            ensureWatchers(config);
        }
        catch (err) {
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
async function maybeRunSelfTest() {
    const markerPath = (0, path_1.join)((0, os_1.homedir)(), '.kiro-remote-bridge-selftest');
    const resultPath = (0, path_1.join)((0, os_1.homedir)(), '.kiro-remote-bridge-selftest-result.txt');
    try {
        (0, fs_1.statSync)(markerPath);
    }
    catch {
        return; // no marker, nothing to do
    }
    const lines = [`started ${new Date().toISOString()}`];
    try {
        (0, fs_1.unlinkSync)(markerPath); // run at most once per marker
    }
    catch {
        // ignore
    }
    try {
        const commands = await vscode.commands.getCommands(true);
        lines.push(`sendPrompt command registered: ${commands.includes('kiroAgent.sessions.sendPrompt')}`);
        lines.push(`create command registered: ${commands.includes('kiroAgent.sessions.create')}`);
        const created = (await vscode.commands.executeCommand('kiroAgent.sessions.create'));
        lines.push(`created sessionId: ${created?.sessionId ?? '(none)'}`);
        if (created?.sessionId) {
            await vscode.commands.executeCommand('kiroAgent.sessions.sendPrompt', created.sessionId, 'selftest do kiro-remote-bridge: responda apenas "ok"');
            lines.push('sendPrompt resolved without throwing');
        }
        lines.push('RESULT: PASS');
    }
    catch (err) {
        lines.push(`RESULT: FAIL — ${describeError(err)}`);
    }
    try {
        (0, fs_1.writeFileSync)(resultPath, lines.join('\n') + '\n');
    }
    catch {
        // ignore
    }
    log(lines.join(' | '));
}
function deactivate() {
    if (pollTimer)
        clearTimeout(pollTimer);
    if (discoverTimer)
        clearInterval(discoverTimer);
    for (const watcher of watchers.values())
        clearInterval(watcher.timer);
    watchers.clear();
}
function restartPolling(context) {
    if (pollTimer)
        clearTimeout(pollTimer);
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
    }
    catch (err) {
        log(`Initial discovery failed: ${describeError(err)}`);
    }
    startDiscovery();
    void pollLoop(context);
}
async function pollLoop(context) {
    const config = readConfig();
    if (!config.enabled || !config.relayUrl || !config.agentSecret)
        return;
    try {
        const events = await pull(config.relayUrl, config.agentSecret);
        lastPollError = null;
        for (const event of events) {
            // Untagged events belong to the daemon's own separate default chat, not
            // any local IDE session — nothing here is ours to act on.
            if (!event.sessionId)
                continue;
            if (event.type === 'user_message' && event.text) {
                await handleRemoteMessage(config, event.sessionId, event.text, event.id);
            }
            else if (event.type === 'approval_response' && event.requestId && event.decision) {
                await handleRemoteApprovalResponse(config, event.sessionId, event.requestId, event.decision, event.id);
            }
        }
    }
    catch (err) {
        lastPollError = describeError(err);
        log(`Poll failed: ${lastPollError}`);
    }
    finally {
        pollTimer = setTimeout(() => void pollLoop(context), config.pollIntervalMs);
    }
}
/**
 * Delivers one remote message into a local session, if that session belongs
 * to this window. Every Kiro window runs its own copy of this extension, so
 * we filter by workspace and then claim the message on the relay to make
 * sure exactly one window delivers it.
 */
async function handleRemoteMessage(config, sessionId, text, eventId) {
    const isNew = sessionId === NEW_SESSION_SENTINEL;
    // A "create a new session" request isn't tied to a workspace yet, so any
    // window could serve it; the claim below decides which one does. For an
    // existing session, only the window that owns its workspace handles it.
    if (!isNew && !sessionBelongsToThisWindow(sessionId))
        return;
    const claimed = await claim(config.relayUrl, config.agentSecret, eventId);
    if (!claimed) {
        log(`Skipped ${shortId(sessionId)}: another window already claimed this message.`);
        return;
    }
    try {
        let targetSessionId = sessionId;
        if (isNew) {
            const created = (await vscode.commands.executeCommand('kiroAgent.sessions.create'));
            if (!created?.sessionId)
                throw new Error('o IDE não retornou o id da nova sessão');
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
    }
    catch (err) {
        const message = describeError(err);
        log(`Failed to deliver to ${shortId(sessionId)}: ${message}`);
        await pushError(config, sessionId, `Falha ao entregar no Kiro IDE: ${message}`);
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
async function handleRemoteApprovalResponse(config, sessionId, requestId, decision, eventId) {
    if (!sessionBelongsToThisWindow(sessionId))
        return;
    const pending = pendingApprovals.get(requestId);
    if (!pending || pending.sessionId !== sessionId) {
        // Either this window never streamed the originating prompt, or it was
        // already resolved (e.g. answered directly in the IDE). Nothing to do.
        return;
    }
    const claimed = await claim(config.relayUrl, config.agentSecret, eventId);
    if (!claimed)
        return;
    const command = approvalCommandForDecision(decision);
    if (!command) {
        log(`Unknown approval decision "${decision}" for ${shortId(sessionId)}, ignoring.`);
        return;
    }
    approvalQueue = approvalQueue.then(() => dispatchApprovalDecision(config, sessionId, requestId, command));
    await approvalQueue;
}
function approvalCommandForDecision(decision) {
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
async function dispatchApprovalDecision(config, sessionId, requestId, command) {
    try {
        // Make sure the right panel is focused before firing a command that acts
        // on "the currently active panel" rather than a session id.
        await vscode.commands.executeCommand('kiroAgent.viewSession', sessionId);
        await vscode.commands.executeCommand(command);
        log(`Dispatched ${command} for ${shortId(sessionId)} (request ${shortId(requestId)})`);
        const confirmed = await waitForApprovalResolved(requestId, APPROVAL_CONFIRM_TIMEOUT_MS);
        if (!confirmed) {
            log(`Approval ${shortId(requestId)} on ${shortId(sessionId)} was not confirmed resolved within ${APPROVAL_CONFIRM_TIMEOUT_MS}ms.`);
            await pushError(config, sessionId, 'Não foi possível confirmar que a aprovação foi aplicada no IDE. Verifique a sessão diretamente.');
        }
    }
    catch (err) {
        const message = describeError(err);
        log(`Failed to dispatch ${command} for ${shortId(sessionId)}: ${message}`);
        await pushError(config, sessionId, `Falha ao aplicar aprovação no Kiro IDE: ${message}`);
    }
}
/** Polls until `pendingApprovals` no longer has this entry (cleared by the matching interaction_resolved), or times out. */
async function waitForApprovalResolved(requestId, timeoutMs) {
    const pollStep = 300;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!pendingApprovals.has(requestId))
            return true;
        await new Promise((resolve) => setTimeout(resolve, pollStep));
    }
    return !pendingApprovals.has(requestId);
}
const watchers = new Map();
/** Messages this window delivered, so the file echo of them isn't re-sent. */
const recentlyDelivered = [];
/**
 * Tracks tool approval prompts this window has surfaced to the relay, so an
 * approval_response from the phone (which only carries the relay's own
 * event id) can be mapped back to the Kiro-side toolCallId it answers.
 * Cleared once the interaction resolves, one way or another.
 */
const pendingApprovals = new Map();
/** toolCallId -> display title, filled in from the preceding tool_call entry so the approval card can show what's being approved. */
const toolTitleByCallId = new Map();
/**
 * Serializes approval dispatches within this window. The IDE's
 * trust/rejectAll/runOrAcceptAll commands act on "whichever chat panel is
 * currently active" rather than a specific session id, so two decisions
 * racing each other could resolve the wrong session's prompt if run
 * concurrently.
 */
let approvalQueue = Promise.resolve();
/**
 * Keeps the set of streamed sessions in sync with what's actually active in
 * this window: every session of this workspace touched in the last day, most
 * recent first, capped so we don't tail hundreds of old files.
 *
 * This runs on a timer rather than only when the phone sends something, so a
 * session you started and are driving inside the IDE also streams to the
 * phone without you having to touch the web first.
 */
function ensureWatchers(config) {
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
function watchSessionForReplies(config, sessionId) {
    if (watchers.has(sessionId))
        return;
    const sessionDir = findSessionDir(sessionId);
    if (!sessionDir) {
        log(`Cannot watch ${shortId(sessionId)}: session directory not found.`);
        return;
    }
    const messagesPath = (0, path_1.join)(sessionDir, 'messages.jsonl');
    const watcher = {
        offset: fileSize(messagesPath), // only forward what comes after this point
        timer: setInterval(() => {
            try {
                tickWatcher(config, sessionId, messagesPath);
            }
            catch (err) {
                log(`Watcher error for ${shortId(sessionId)}: ${describeError(err)}`);
            }
        }, WATCH_INTERVAL_MS),
    };
    watchers.set(sessionId, watcher);
    log(`Watching ${shortId(sessionId)} (from byte ${watcher.offset}).`);
}
function tickWatcher(config, sessionId, messagesPath) {
    const watcher = watchers.get(sessionId);
    if (!watcher)
        return;
    const size = fileSize(messagesPath);
    if (size < watcher.offset) {
        watcher.offset = size; // file was rewritten/truncated; resync
        return;
    }
    if (size === watcher.offset)
        return;
    const chunk = readFrom(messagesPath, watcher.offset, size);
    // Only advance past whole lines, so a half-written line is re-read next tick.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0)
        return;
    watcher.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');
    for (const line of chunk.slice(0, lastNewline).split('\n')) {
        forwardLine(config, sessionId, line);
    }
}
/** Turns one messages.jsonl line into a relay event, skipping bookkeeping entries. */
function forwardLine(config, sessionId, line) {
    if (!line.trim())
        return;
    let payload;
    try {
        payload = JSON.parse(line).payload;
    }
    catch {
        return;
    }
    if (!payload)
        return;
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
        if (!text)
            return;
        // Kiro writes both the model's internal reasoning and its actual reply as
        // `assistant` entries; `operationType` is the only thing that separates
        // them ("Reasoning" vs "Say"). Forwarding them as distinct event types is
        // what lets the phone collapse thinking the way the IDE does instead of
        // showing it as a second answer bubble.
        const isReasoning = String(payload.operationType ?? '') === 'Reasoning';
        void push(config, {
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
        if (toolCallId)
            toolTitleByCallId.set(toolCallId, title);
        void push(config, {
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
        if (!toolCallId)
            return;
        const question = typeof payload.question === 'string' ? payload.question : 'tool_approval';
        const title = toolTitleByCallId.get(toolCallId);
        void push(config, {
            type: 'approval_request',
            promptText: question,
            ...(title ? { toolName: title } : {}),
            sessionId,
        }).then((relayEventId) => {
            if (relayEventId)
                pendingApprovals.set(relayEventId, { sessionId, toolCallId });
        });
        return;
    }
    if (type === 'interaction_resolved') {
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
        if (!toolCallId)
            return;
        // The developer answered this prompt directly in the IDE (rather than
        // from the phone) — find our matching pending entry, if any, so the
        // phone doesn't keep showing it as unresolved.
        for (const [relayEventId, entry] of pendingApprovals) {
            if (entry.toolCallId !== toolCallId)
                continue;
            pendingApprovals.delete(relayEventId);
            const decision = decisionFromSelectedOption(typeof payload.selectedOption === 'string' ? payload.selectedOption : undefined);
            void resolveApprovalOnRelay(config, relayEventId, decision);
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
function summarizeToolArgs(args) {
    if (!args || typeof args !== 'object')
        return undefined;
    const record = args;
    for (const key of DETAIL_ARG_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return truncateDetail(value);
        }
    }
    if (Array.isArray(record.paths) && record.paths.length > 0) {
        const joined = record.paths.filter((p) => typeof p === 'string').join(', ');
        if (joined)
            return truncateDetail(joined);
    }
    return undefined;
}
function truncateDetail(text) {
    return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}
/**
 * Pulls file basenames out of a tool_call's args, the way the IDE tags a
 * "Read Files"/"Read File" row with small file-name chips. Only looks at
 * the arg shapes actually used by file-oriented tools (`path`, `paths`,
 * `filePath`, `targetFile`) — anything else (grep queries, shell commands)
 * has no natural "file" to show and is left without badges.
 */
function extractFileBasenames(args) {
    if (!args || typeof args !== 'object')
        return [];
    const record = args;
    const candidates = [
        record.path,
        record.filePath,
        record.targetFile,
        record.sourcePath,
        record.destinationPath,
        ...(Array.isArray(record.paths) ? record.paths : []),
    ];
    const basenames = [];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0)
            continue;
        const basename = candidate.split(/[/\\]/).pop();
        if (basename)
            basenames.push(basename);
    }
    return basenames.slice(0, 8);
}
function decisionFromSelectedOption(optionId) {
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
function markDelivered(sessionId, text) {
    const now = Date.now();
    recentlyDelivered.push({ sessionId, text: text.trim(), at: now });
    while (recentlyDelivered.length > 0 && now - recentlyDelivered[0].at > ECHO_WINDOW_MS) {
        recentlyDelivered.shift();
    }
}
function wasJustDelivered(sessionId, text) {
    const now = Date.now();
    return recentlyDelivered.some((entry) => entry.sessionId === sessionId && entry.text === text.trim() && now - entry.at <= ECHO_WINDOW_MS);
}
/**
 * Sessions of this window's workspace that were modified recently, newest
 * first. Reads only session.json metadata, never the transcripts.
 */
function recentSessionsForThisWindow() {
    const ourPaths = currentWorkspacePaths();
    if (ourPaths.length === 0)
        return [];
    const found = [];
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    let workspaceDirs;
    try {
        workspaceDirs = (0, fs_1.readdirSync)(KIRO_SESSIONS_DIR);
    }
    catch {
        return [];
    }
    for (const workspaceDir of workspaceDirs) {
        const workspacePath = (0, path_1.join)(KIRO_SESSIONS_DIR, workspaceDir);
        let sessionDirs;
        try {
            if (!(0, fs_1.statSync)(workspacePath).isDirectory())
                continue;
            sessionDirs = (0, fs_1.readdirSync)(workspacePath);
        }
        catch {
            continue;
        }
        for (const sessionId of sessionDirs) {
            const messagesPath = (0, path_1.join)(workspacePath, sessionId, 'messages.jsonl');
            let modifiedAt;
            try {
                modifiedAt = (0, fs_1.statSync)(messagesPath).mtimeMs;
            }
            catch {
                continue; // no transcript yet, nothing to stream
            }
            if (modifiedAt < cutoff)
                continue;
            const sessionPaths = readSessionWorkspacePaths(sessionId);
            if (!sessionPaths || !sameWorkspace(sessionPaths, ourPaths))
                continue;
            found.push({ sessionId, modifiedAt });
        }
    }
    return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
function findSessionDir(sessionId) {
    let workspaceDirs;
    try {
        workspaceDirs = (0, fs_1.readdirSync)(KIRO_SESSIONS_DIR);
    }
    catch {
        return null;
    }
    for (const workspaceDir of workspaceDirs) {
        const candidate = (0, path_1.join)(KIRO_SESSIONS_DIR, workspaceDir, sessionId);
        try {
            if ((0, fs_1.statSync)((0, path_1.join)(candidate, 'session.json')).isFile())
                return candidate;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
function fileSize(path) {
    try {
        return (0, fs_1.statSync)(path).size;
    }
    catch {
        return 0;
    }
}
function readFrom(path, start, end) {
    const length = end - start;
    if (length <= 0)
        return '';
    const buffer = Buffer.alloc(length);
    const fd = (0, fs_1.openSync)(path, 'r');
    try {
        const read = (0, fs_1.readSync)(fd, buffer, 0, length, start);
        return buffer.subarray(0, read).toString('utf8');
    }
    finally {
        (0, fs_1.closeSync)(fd);
    }
}
/**
 * A session's own session.json records the workspace it was created in. We
 * only handle sessions whose workspace matches this window exactly, so that
 * with several Kiro windows open each one only answers for its own chats.
 */
function sessionBelongsToThisWindow(sessionId) {
    const sessionPaths = readSessionWorkspacePaths(sessionId);
    if (!sessionPaths)
        return false;
    return sameWorkspace(sessionPaths, currentWorkspacePaths());
}
function sameWorkspace(sessionPaths, ourPaths) {
    if (sessionPaths.length === 0 || ourPaths.length === 0)
        return false;
    return (sessionPaths.every((path) => ourPaths.includes(path)) &&
        ourPaths.every((path) => sessionPaths.includes(path)));
}
function readSessionWorkspacePaths(sessionId) {
    let workspaceDirs;
    try {
        workspaceDirs = (0, fs_1.readdirSync)(KIRO_SESSIONS_DIR);
    }
    catch {
        return null;
    }
    for (const workspaceDir of workspaceDirs) {
        const candidate = (0, path_1.join)(KIRO_SESSIONS_DIR, workspaceDir, sessionId, 'session.json');
        try {
            if (!(0, fs_1.statSync)(candidate).isFile())
                continue;
            const parsed = JSON.parse((0, fs_1.readFileSync)(candidate, 'utf8'));
            const paths = Array.isArray(parsed.workspacePaths) ? parsed.workspacePaths.map(String) : [];
            return paths;
        }
        catch {
            // not this workspace dir, or unreadable — keep looking
        }
    }
    return null;
}
function currentWorkspacePaths() {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}
// --- relay calls ---
async function pull(relayUrl, secret) {
    const url = new URL('/api/agent/pull', relayUrl);
    url.searchParams.set('since', String(cursor));
    url.searchParams.set('host', HOST_LABEL);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok)
        throw new Error(`pull ${res.status}`);
    const body = (await res.json());
    if (body.events.length > 0) {
        cursor = Math.max(cursor, ...body.events.map((event) => event.createdAt));
    }
    return body.events;
}
/** Atomic "only one window handles this message" check. */
async function claim(relayUrl, secret, eventId) {
    const url = new URL('/api/agent/claim', relayUrl);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ eventId, by: HOST_LABEL }),
    });
    if (!res.ok)
        throw new Error(`claim ${res.status}`);
    const body = (await res.json());
    return body.claimed;
}
async function pushStatus(config, sessionId, text) {
    await push(config, { type: 'status', text, sessionId });
}
async function pushError(config, sessionId, text) {
    await push(config, { type: 'error', text, sessionId });
}
/** Returns the relay-assigned id of the created event, or undefined if the push failed. */
async function push(config, payload) {
    try {
        const url = new URL('/api/agent/push', config.relayUrl);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentSecret}` },
            body: JSON.stringify(payload),
        });
        if (!res.ok)
            throw new Error(`push ${res.status}`);
        const body = (await res.json());
        return body.event?.id;
    }
    catch (err) {
        log(`Push failed: ${describeError(err)}`);
        return undefined;
    }
}
/**
 * Tells the relay an approval_request has been resolved, without going
 * through the phone's owner-session route — used when the developer
 * answered a prompt directly in the IDE.
 */
async function resolveApprovalOnRelay(config, relayEventId, decision) {
    try {
        const url = new URL('/api/agent/approvals/resolve', config.relayUrl);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentSecret}` },
            body: JSON.stringify({ requestId: relayEventId, decision }),
        });
        if (!res.ok)
            throw new Error(`resolve ${res.status}`);
    }
    catch (err) {
        log(`Resolve approval failed: ${describeError(err)}`);
    }
}
function readConfig() {
    const config = vscode.workspace.getConfiguration('kiroRemoteBridge');
    return {
        enabled: config.get('enabled', true),
        relayUrl: (config.get('relayUrl', '') ?? '').replace(/\/+$/, ''),
        agentSecret: config.get('agentSecret', '') ?? '',
        pollIntervalMs: config.get('pollIntervalMs', 4000),
    };
}
function shortId(sessionId) {
    return sessionId.length > 16 ? `${sessionId.slice(0, 16)}…` : sessionId;
}
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function log(message) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
}
