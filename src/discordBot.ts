import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type Message,
  type MessageCreateOptions,
  type ThreadChannel,
} from 'discord.js';
import type { AgentConfig } from './config';
import type { Hub, ApprovalResolvedInfo } from './hub';
import type { HubEvent, ToolApprovalDecision } from './hubProtocol';

/** Discord hard-caps a single message at this many characters. */
const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord thread/post title cap. */
const DISCORD_TITLE_LIMIT = 100;
/** Sentinel meaning "the daemon's own fixed default kiro-cli session" — kept out of the sessionId->thread map's key space since it maps to a persistent thread instead of a dynamically created one. */
const DEFAULT_SESSION_KEY = '__default__';
/**
 * Sentinel meaning "create a brand new Kiro IDE session for this prompt".
 * Must match NEW_SESSION_SENTINEL in ide-extension/src/extension.ts — that
 * extension already implements the other half of this flow (creating the
 * session via `kiroAgent.sessions.create` and replying with a
 * `status: "session:<id>"` event tagged with this same sentinel). This
 * constant is never written into the persisted thread map; it only routes
 * one request through the hub.
 */
const NEW_SESSION_SENTINEL = '__new__';

interface ThreadMapFile {
  /** sessionId (or DEFAULT_SESSION_KEY) -> Discord thread id. */
  threads: Record<string, string>;
}

/**
 * Discord is now the entire "remote client" side of this system — it
 * replaces the old phone/browser PWA, the Vercel relay that served it,
 * and the Cloudflare Tunnel that exposed the hub publicly. None of that
 * infrastructure exists anymore: this bot runs in the same process as the
 * daemon, connects *outbound* to Discord's gateway (so, like everything
 * else in this daemon, it never needs an open inbound port), and Discord
 * itself provides push notifications, a real mobile app, and durable
 * message history for free.
 *
 * Layout: one Forum channel (DISCORD_FORUM_CHANNEL_ID), one thread per
 * chat — the daemon's fixed default session gets a single persistent
 * thread (created on first use, then reused forever); every local Kiro
 * IDE session gets its own thread, created the first time an event for
 * that sessionId arrives. The mapping is persisted to a small JSON file
 * (THREAD_MAP_PATH) so restarting the daemon doesn't create duplicate
 * threads for sessions that already have one.
 *
 * Sending a plain message (not a reply/slash command) inside a session's
 * thread is how you talk back to that session — mirrors the old
 * chat-input-box UX with zero custom UI needed.
 */
export class DiscordBot {
  private readonly client: Client;
  private readonly threadMapPath: string;
  private threadMap: Record<string, string>;
  /** requestId -> discord message, so a button click can edit the original message to show the outcome. */
  private readonly pendingApprovalMessages = new Map<string, Message>();
  /** toolName shown alongside a pending approval_request, purely for the edited message's final text. */
  private readonly pendingApprovalMeta = new Map<string, { promptText: string; toolName?: string }>();
  private ready = false;
  /** Events that arrive before the client finishes logging in (e.g. the daemon's own startup status message) are buffered here and flushed once ready, instead of being silently dropped. */
  private readonly pendingEvents: HubEvent[] = [];
  /**
   * Discord thread ids waiting for a Kiro IDE window to report back which
   * real sessionId it created, FIFO. The Kiro Remote Bridge extension
   * doesn't correlate its "session:<id>" status reply to any particular
   * caller — for a single-owner, one-request-at-a-time tool this queue is
   * enough to match each new-session request to the thread that asked
   * for it.
   */
  private readonly pendingNewSessionThreads: string[] = [];

  constructor(
    private readonly config: AgentConfig,
    private readonly hub: Hub,
  ) {
    this.threadMapPath = config.DISCORD_THREAD_MAP_PATH;
    this.threadMap = this.loadThreadMap();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, () => {
      this.ready = true;
      console.log(`[discord] logged in as ${this.client.user?.tag}`);
      const buffered = this.pendingEvents.splice(0, this.pendingEvents.length);
      for (const event of buffered) {
        void this.handleHubEvent(event);
      }
    });

    this.client.on(Events.MessageCreate, (message) => void this.handleMessage(message));
    this.client.on(Events.ThreadCreate, (thread) => void this.handleThreadCreate(thread));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) void this.handleButton(interaction);
    });

    this.hub.onEvent = (event) => void this.handleHubEvent(event);
    this.hub.onApprovalResolved = (info) => void this.handleApprovalResolved(info);
  }

  async start(): Promise<void> {
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  // --- incoming from Discord ---

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!this.ready) return;

    const channel = message.channel;
    if (!channel.isThread()) return; // only thread replies are chat input; the forum channel's top level is just a list of posts
    if (channel.parentId !== this.config.DISCORD_FORUM_CHANNEL_ID) return;

    const sessionId = this.sessionIdForThread(channel.id);
    if (sessionId === undefined) return; // a thread we don't recognize (e.g. created manually) — ignore

    const text = message.content.trim();
    if (!text) return;

    this.hub.sendUserMessage(text, sessionId === DEFAULT_SESSION_KEY ? undefined : sessionId);
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [prefix, decision, requestId] = interaction.customId.split(':');
    if (prefix !== 'approval') return;
    await interaction.deferUpdate();

    const channel = interaction.channel;
    const sessionId =
      channel && 'isThread' in channel && channel.isThread() ? this.sessionIdForThread(channel.id) : undefined;

    this.hub.respondToApproval(
      requestId!,
      decision as ToolApprovalDecision,
      sessionId === DEFAULT_SESSION_KEY ? undefined : sessionId,
    );
    // The actual message edit happens in handleApprovalResolved, triggered
    // by the hub's onApprovalResolved callback — this keeps "a decision was
    // applied" a single code path regardless of whether it came from this
    // button or from resolving the prompt directly in the IDE.
  }

  // --- outgoing to Discord ---

  private async handleHubEvent(event: HubEvent): Promise<void> {
    if (!this.ready) {
      this.pendingEvents.push(event);
      return;
    }
    // approval_response is purely informational for the extension/daemon
    // side; Discord's view of "this was answered" comes from
    // handleApprovalResolved editing the original approval_request message
    // instead, so there's nothing additional to post for this type.
    if (event.type === 'approval_response') return;
    // The daemon's own PTY session echoes back whatever text it was sent,
    // and the message the user typed into the thread is already visible
    // there — posting it again as a bot message would just double it.
    if (event.type === 'user_message') return;

    // The extension's reply to a NEW_SESSION_SENTINEL request: not a
    // message to display, but the signal to map the waiting forum thread
    // to the real session id the IDE just created.
    if (event.type === 'status' && event.sessionId === NEW_SESSION_SENTINEL && event.text.startsWith('session:')) {
      await this.handleNewSessionCreated(event.text.slice('session:'.length));
      return;
    }
    // The only other event the extension tags with the sentinel is an
    // error from a failed session creation (see extension.ts's
    // handleRemoteMessage catch block) — route it to whichever forum
    // thread is still waiting rather than creating a thread keyed by the
    // literal sentinel string.
    if (event.sessionId === NEW_SESSION_SENTINEL) {
      const threadId = this.pendingNewSessionThreads.shift();
      const thread = threadId ? await this.fetchThread(threadId) : null;
      const text = formatEventText(event);
      if (thread && text) await thread.send(text).catch(() => {});
      return;
    }

    try {
      const thread = await this.getOrCreateThread(event.sessionId);
      if (!thread) return;

      if (event.type === 'approval_request') {
        await this.postApprovalRequest(thread, event.id, event.promptText, event.toolName);
        return;
      }

      const text = formatEventText(event);
      if (!text) return;
      await this.sendChunked(thread, text);
    } catch (err) {
      console.error('[discord] failed to deliver event:', err);
    }
  }

  private async postApprovalRequest(
    thread: ThreadChannel,
    requestId: string,
    promptText: string,
    toolName: string | undefined,
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approval:approve:${requestId}`)
        .setLabel('Aprovar')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`approval:approve_always:${requestId}`)
        .setLabel('Sempre')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`approval:deny:${requestId}`)
        .setLabel('Recusar')
        .setStyle(ButtonStyle.Danger),
    );

    const header = toolName ? `**Aprovação necessária · ${escapeMarkdown(toolName)}**` : '**Aprovação necessária**';
    const body = truncate(promptText, DISCORD_MESSAGE_LIMIT - header.length - 20);

    const sent = await thread.send({ content: `${header}\n\`\`\`\n${body}\n\`\`\``, components: [row] });
    this.pendingApprovalMessages.set(requestId, sent);
    this.pendingApprovalMeta.set(requestId, { promptText, toolName });
  }

  private async handleApprovalResolved(info: ApprovalResolvedInfo): Promise<void> {
    const message = this.pendingApprovalMessages.get(info.requestId);
    const meta = this.pendingApprovalMeta.get(info.requestId);
    if (!message || !meta) return;
    this.pendingApprovalMessages.delete(info.requestId);
    this.pendingApprovalMeta.delete(info.requestId);

    const header = meta.toolName
      ? `**Aprovação · ${escapeMarkdown(meta.toolName)}**`
      : '**Aprovação**';
    const body = truncate(meta.promptText, DISCORD_MESSAGE_LIMIT - header.length - 40);
    const decisionLabel = describeDecision(info.decision);

    try {
      await message.edit({
        content: `${header}\n\`\`\`\n${body}\n\`\`\`\n✅ Decisão: **${decisionLabel}**`,
        components: [],
      });
    } catch (err) {
      console.error('[discord] failed to edit resolved approval message:', err);
    }
  }

  // --- new-session flow: a fresh forum post starts a new Kiro IDE session ---

  /**
   * Fires for every new thread in the guild, including ones this bot
   * itself created via getOrCreateThread — those are filtered out by
   * checking the thread map so this doesn't loop back on itself. A forum
   * post the *user* created (through Discord's own "new post" UI) has its
   * first message content used as the initial prompt, and is routed
   * through the extension's NEW_SESSION_SENTINEL flow to create a real
   * Kiro IDE session, exactly like starting a new session used to work
   * from the old PWA's "Nova sessão" composer.
   */
  private async handleThreadCreate(thread: ThreadChannel): Promise<void> {
    if (!this.ready) return;
    if (thread.parentId !== this.config.DISCORD_FORUM_CHANNEL_ID) return;
    if (this.sessionIdForThread(thread.id) !== undefined) return; // a thread we already created/track

    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const text = starter?.content.trim();
      if (!text) {
        await thread.send('⚠️ Não encontrei nenhum texto na primeira mensagem deste post — envie o pedido inicial no corpo do post.');
        return;
      }

      this.pendingNewSessionThreads.push(thread.id);
      this.hub.sendUserMessage(text, NEW_SESSION_SENTINEL);
    } catch (err) {
      console.error('[discord] failed to handle new forum post:', err);
    }
  }

  /** Routes the extension's `status: "session:<id>"` reply (tagged with NEW_SESSION_SENTINEL) to whichever pending forum post is waiting longest, mapping that thread to the real sessionId from now on. */
  private async handleNewSessionCreated(realSessionId: string): Promise<void> {
    const threadId = this.pendingNewSessionThreads.shift();
    if (!threadId) return; // no thread was waiting; nothing to map

    this.threadMap[realSessionId] = threadId;
    this.saveThreadMap();

    const thread = await this.fetchThread(threadId);
    await thread?.send(`✅ Sessão criada no Kiro IDE: \`${realSessionId}\``).catch(() => {});
  }

  // --- thread <-> session mapping ---

  private async getOrCreateThread(sessionId: string | undefined): Promise<ThreadChannel | null> {
    const key = sessionId ?? DEFAULT_SESSION_KEY;
    const existingId = this.threadMap[key];
    if (existingId) {
      const existing = await this.fetchThread(existingId);
      if (existing) return existing;
      // The thread was deleted on Discord's side; fall through and make a new one.
    }

    const forum = await this.client.channels.fetch(this.config.DISCORD_FORUM_CHANNEL_ID);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      console.error('[discord] DISCORD_FORUM_CHANNEL_ID does not point to a forum channel');
      return null;
    }

    const title = truncate(sessionTitle(sessionId, this.hub), DISCORD_TITLE_LIMIT);
    const created = await forum.threads.create({
      name: title,
      message: { content: sessionId ? `Sessão local: \`${sessionId}\`` : 'Chat padrão do agente.' },
    });

    this.threadMap[key] = created.id;
    this.saveThreadMap();
    return created;
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel && channel.isThread()) return channel;
      return null;
    } catch {
      return null;
    }
  }

  /** Reverse lookup used when a Discord message/button arrives, to find which sessionId (or DEFAULT_SESSION_KEY) a thread belongs to. */
  private sessionIdForThread(threadId: string): string | undefined {
    for (const [key, id] of Object.entries(this.threadMap)) {
      if (id === threadId) return key;
    }
    return undefined;
  }

  private async sendChunked(thread: ThreadChannel, text: string): Promise<void> {
    for (const chunk of splitForDiscord(text)) {
      const options: MessageCreateOptions = { content: chunk };
      await thread.send(options);
    }
  }

  private loadThreadMap(): Record<string, string> {
    try {
      const raw = readFileSync(this.threadMapPath, 'utf8');
      const parsed = JSON.parse(raw) as ThreadMapFile;
      return parsed.threads ?? {};
    } catch {
      return {};
    }
  }

  private saveThreadMap(): void {
    try {
      const dir = dirname(this.threadMapPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload: ThreadMapFile = { threads: this.threadMap };
      writeFileSync(this.threadMapPath, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error('[discord] failed to persist thread map:', err);
    }
  }
}

// --- formatting helpers ---

function formatEventText(event: HubEvent): string | null {
  switch (event.type) {
    case 'assistant_message':
      return event.text;
    case 'thought':
      return `> 💭 _${event.text}_`;
    case 'status':
      return `ℹ️ ${event.text}`;
    case 'error':
      return `⚠️ ${event.text}`;
    case 'tool_call': {
      const filesSuffix = event.files && event.files.length > 0 ? ` (${event.files.join(', ')})` : '';
      const detailSuffix = event.detail ? `\n\`\`\`\n${truncate(event.detail, 500)}\n\`\`\`` : '';
      return `🔧 **${escapeMarkdown(event.title)}**${filesSuffix}${detailSuffix}`;
    }
    default:
      return null;
  }
}

function describeDecision(decision: ToolApprovalDecision): string {
  switch (decision) {
    case 'approve':
      return 'Aprovado';
    case 'approve_always':
      return 'Aprovado (sempre)';
    case 'deny':
      return 'Recusado';
  }
}

function sessionTitle(sessionId: string | undefined, hub: Hub): string {
  if (!sessionId) return 'Chat padrão';
  const local = hub.getLocalSessions().find((s) => s.id === sessionId);
  return local?.title || `Sessão ${sessionId.slice(0, 8)}`;
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 1) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Escapes Discord markdown special characters so untrusted tool/session text can't break formatting. */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\])/g, '\\$1');
}

/** Splits text into chunks that each fit within DISCORD_MESSAGE_LIMIT, breaking on line boundaries where possible. */
function splitForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT);
    if (cut <= 0) cut = DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  return chunks;
}
