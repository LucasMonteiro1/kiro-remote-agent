import { z } from 'zod';

/**
 * All configuration comes from environment variables (loaded from .env via
 * dotenv in index.ts). Nothing here should ever be committed — see
 * .env.example for the template.
 */
const envSchema = z.object({
  // --- Local hub server (talks only to the Kiro Remote Bridge IDE extension) ---
  /** Local port the WebSocket hub listens on. Only the Kiro Remote Bridge extension connects here — it's not exposed to the internet. */
  HUB_PORT: z.coerce.number().int().positive().default(8787),
  /** Shared secret the Kiro Remote Bridge extension uses to authenticate to the hub. Must match kiroRemoteBridge.hubSecret in every IDE window's settings. */
  HUB_SHARED_SECRET: z.string().min(16),
  HOST_LABEL: z.string().default('work-pc'),

  // --- Discord (the remote client — replaces the old phone/browser PWA + relay + tunnel) ---
  /** Bot token from the Discord Developer Portal (Application -> Bot -> Reset Token). */
  DISCORD_BOT_TOKEN: z.string().min(1),
  /** ID of the forum channel where session threads are created. Right-click the channel in Discord (Developer Mode enabled) -> Copy Channel ID. */
  DISCORD_FORUM_CHANNEL_ID: z.string().min(1),
  /** Where the sessionId <-> Discord thread id mapping is persisted, so restarting the daemon reuses existing threads instead of creating duplicates. */
  DISCORD_THREAD_MAP_PATH: z.string().default('./discord-threads.json'),

  /** How often (ms) to scan ~/.kiro/sessions and refresh the daemon's local cache of Kiro IDE session titles/status (used only to label new Discord threads). */
  SESSION_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(45000),

  // --- kiro-cli process ---
  KIRO_CLI_BIN: z.string().default('kiro-cli'),
  KIRO_PROJECT_DIR: z.string().min(1),
  KIRO_SESSION_ID: z.string().optional(),
  /** Comma-separated tool trust categories, e.g. "read,grep". Empty = none pre-trusted. */
  KIRO_TRUST_TOOLS: z.string().default(''),
  KIRO_API_KEY: z.string().optional(),

  // --- Approval prompt detection (tune these after watching debug.log once) ---
  APPROVAL_PROMPT_REGEX: z
    .string()
    .default('(?i)(allow this|permission|do you want to (proceed|allow)|trust this tool|\\[y/n\\]|\\(y/n\\))'),
  IDLE_MS_BEFORE_TURN_COMPLETE: z.coerce.number().int().positive().default(1500),

  // --- Keystrokes sent back into the PTY for each approval decision ---
  APPROVE_KEYSTROKES: z.string().default('y\r'),
  DENY_KEYSTROKES: z.string().default('n\r'),
  APPROVE_ALWAYS_KEYSTROKES: z.string().default('a\r'),

  // --- Auto-update (only active when running under the managed install layout) ---
  /** Master switch for the self-updater. When false, the daemon never checks for or applies updates. */
  AUTO_UPDATE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** How often (ms) to check the GitHub Releases API for a newer version. Default 1h. */
  UPDATE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
  /** owner/repo whose GitHub Releases the updater pulls from. Lets a fork point at its own canonical repo. */
  UPDATE_REPO: z.string().default('LucasMonteiro1/kiro-remote-agent'),

  // --- Audio transcription (local, via bundled whisper.cpp + ffmpeg) ---
  // All of these default to "on with sensible values", and the binaries/model
  // ship inside the release tarball (see release.yml), so a dev who
  // auto-updates gets voice-message transcription with zero .env changes.
  /** Master switch. When false, audio attachments are ignored instead of transcribed. */
  TRANSCRIBE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** ggml model name bundled in the release, used to build the default model filename (ggml-<name>.bin). */
  WHISPER_MODEL: z.string().default('base'),
  /** Transcription language hint. "auto" lets whisper detect it; a concrete code (default "pt" for Brazilian Portuguese) forces one, which is faster and more accurate when the spoken language is known. */
  WHISPER_LANGUAGE: z.string().default('pt'),
  /** Worker threads for whisper-cli. 0 = let whisper pick its own default. */
  WHISPER_THREADS: z.coerce.number().int().nonnegative().default(0),
  /** Override the directory holding the bundled whisper-cli/ffmpeg/model. Defaults to `<release>/vendor`. */
  TRANSCRIBE_VENDOR_DIR: z.string().optional(),
  /** Explicit path to the whisper-cli binary (overrides the vendor-dir default). */
  WHISPER_BIN: z.string().optional(),
  /** Explicit path to the ffmpeg binary (overrides the vendor-dir default). */
  FFMPEG_BIN: z.string().optional(),
  /** Explicit path to the ggml model file (overrides the vendor-dir + WHISPER_MODEL default). */
  WHISPER_MODEL_PATH: z.string().optional(),

  // --- Debug ---
  DEBUG_LOG_PATH: z.string().default('./kiro-remote-agent-debug.log'),
});

export type AgentConfig = z.infer<typeof envSchema> & {
  approvalPromptRegex: RegExp;
  trustToolsList: string[];
};

export function loadConfig(): AgentConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid configuration:\n', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const env = parsed.data;

  // Support an "(?i)" prefix as a poor-man's case-insensitive flag marker
  // since it reads nicely in .env files; strip it and use the `i` flag.
  const caseInsensitive = env.APPROVAL_PROMPT_REGEX.startsWith('(?i)');
  const pattern = caseInsensitive
    ? env.APPROVAL_PROMPT_REGEX.slice(4)
    : env.APPROVAL_PROMPT_REGEX;

  return {
    ...env,
    approvalPromptRegex: new RegExp(pattern, caseInsensitive ? 'i' : ''),
    trustToolsList: env.KIRO_TRUST_TOOLS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
