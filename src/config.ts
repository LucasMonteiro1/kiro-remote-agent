import { z } from 'zod';

/**
 * All configuration comes from environment variables (loaded from .env via
 * dotenv in index.ts). Nothing here should ever be committed — see
 * .env.example for the template.
 */
const envSchema = z.object({
  // --- Relay connection ---
  RELAY_URL: z.string().url(),
  AGENT_SHARED_SECRET: z.string().min(16),
  HOST_LABEL: z.string().default('work-pc'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  /** How often (ms) to scan ~/.kiro/sessions and push a fresh summary snapshot to the relay. */
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
