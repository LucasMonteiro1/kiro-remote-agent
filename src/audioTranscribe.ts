import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, extname, join, resolve } from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import type { AgentConfig } from './config';
import type { MessageAttachment } from './hubProtocol';

const execFileAsync = promisify(execFile);

/** Where downloaded Discord audio attachments (and their converted WAVs) are staged for whisper-cli to read. */
const AUDIO_TMP_DIR = join(tmpdir(), 'kiro-remote-audio');
/** Voice notes are tiny; anything bigger than this is almost certainly not a voice message and we skip it rather than burn time/memory on it. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Extensions Discord uses for voice notes / audio uploads. `audio/*` content types are also accepted (see isAudioAttachment). */
const AUDIO_EXTENSION = /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm|mp4)$/i;

/**
 * True when a Discord attachment looks like audio. Discord voice messages
 * arrive as `voice-message.ogg` with contentType `audio/ogg`; regular audio
 * uploads carry their own `audio/*` type. Falls back to the filename
 * extension when Discord omits the content type.
 */
export function isAudioAttachment(attachment: MessageAttachment): boolean {
  const contentType = attachment.contentType ?? '';
  if (contentType.startsWith('audio/')) return true;
  // Discord voice messages are OGG/Opus; some clients report the generic
  // "application/ogg" instead of "audio/ogg", so treat .ogg/.oga/.opus by
  // extension too.
  return AUDIO_EXTENSION.test(attachment.filename);
}

/**
 * Transcribes one or more audio attachments to text, entirely on this
 * machine, and returns a single combined transcript (empty string if
 * nothing could be transcribed).
 *
 * How it works: each attachment is downloaded to a temp file, converted to
 * the 16 kHz mono WAV whisper.cpp requires (Discord voice notes are
 * OGG/Opus, which whisper-cli can't read directly) using the bundled static
 * ffmpeg, then fed to the bundled whisper-cli against the bundled ggml
 * model. All three binaries ship inside the release tarball (see
 * release.yml), so a dev who auto-updates gets transcription with no setup,
 * no system ffmpeg, and no model download.
 *
 * Everything is best-effort: any failure (missing binaries during a source
 * `yarn dev`, an undecodable file, a whisper crash) resolves to '' so the
 * caller can fall back to delivering the message without a transcript
 * rather than dropping it. `unavailableReason()` explains *why* it's off,
 * for a one-time notice to the user.
 */
export async function transcribeAudioAttachments(
  config: AgentConfig,
  attachments: MessageAttachment[],
): Promise<string> {
  if (!config.TRANSCRIBE_ENABLED) return '';
  const bins = resolveBinaries(config);
  if (!bins) return '';

  const transcripts: string[] = [];
  for (const attachment of attachments) {
    const text = await transcribeOne(config, bins, attachment).catch(() => '');
    if (text) transcripts.push(text);
  }
  return transcripts.join('\n\n').trim();
}

/**
 * Explains why local transcription isn't available, or null when it is.
 * Used by the caller to post a single, actionable notice into the Discord
 * thread the first time an audio message arrives on an install that can't
 * transcribe (e.g. a maintainer running from source without the bundled
 * binaries), instead of silently ignoring the voice note.
 */
export function unavailableReason(config: AgentConfig): string | null {
  if (!config.TRANSCRIBE_ENABLED) return 'Transcrição de áudio desativada (TRANSCRIBE_ENABLED=false).';
  if (!resolveBinaries(config)) {
    return 'Transcrição de áudio indisponível: binários (whisper-cli/ffmpeg/modelo) não encontrados neste ambiente.';
  }
  return null;
}

interface ResolvedBinaries {
  whisperBin: string;
  ffmpegBin: string;
  modelPath: string;
}

/**
 * Locates the three bundled artifacts. All default to the `vendor/`
 * directory that release.yml lays down next to `dist/` in the tarball, but
 * each can be overridden via env for unusual layouts. Returns null if any
 * is missing so the whole feature degrades to "off" cleanly rather than
 * half-working.
 */
function resolveBinaries(config: AgentConfig): ResolvedBinaries | null {
  const vendorDir = config.TRANSCRIBE_VENDOR_DIR
    ? resolve(config.TRANSCRIBE_VENDOR_DIR)
    : defaultVendorDir();

  const whisperBin = config.WHISPER_BIN ? resolve(config.WHISPER_BIN) : join(vendorDir, 'whisper-cli');
  const ffmpegBin = config.FFMPEG_BIN ? resolve(config.FFMPEG_BIN) : join(vendorDir, 'ffmpeg');
  const modelPath = config.WHISPER_MODEL_PATH
    ? resolve(config.WHISPER_MODEL_PATH)
    : join(vendorDir, `ggml-${config.WHISPER_MODEL}.bin`);

  if (!existsSync(whisperBin) || !existsSync(ffmpegBin) || !existsSync(modelPath)) return null;
  return { whisperBin, ffmpegBin, modelPath };
}

/**
 * The release layout is `<release>/dist/*.js` with the transcription
 * artifacts in `<release>/vendor/`. This module lives in dist/ at runtime,
 * so vendor/ is a sibling of __dirname's parent.
 */
function defaultVendorDir(): string {
  // __dirname === <release>/dist
  return join(dirname(__dirname), 'vendor');
}

async function transcribeOne(
  config: AgentConfig,
  bins: ResolvedBinaries,
  attachment: MessageAttachment,
): Promise<string> {
  mkdirSync(AUDIO_TMP_DIR, { recursive: true });
  const stem = randomUUID();
  const srcPath = join(AUDIO_TMP_DIR, `${stem}${safeAudioExtension(attachment.filename)}`);
  const wavPath = join(AUDIO_TMP_DIR, `${stem}.wav`);

  try {
    const downloaded = await downloadAudio(attachment.url, srcPath);
    if (!downloaded) return '';

    // whisper.cpp only accepts 16 kHz mono 16-bit PCM WAV; Discord voice
    // notes are OGG/Opus, so convert unconditionally (also normalizes mp3,
    // m4a, etc. into the one format whisper-cli reads).
    await execFileAsync(bins.ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', srcPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavPath,
    ]);
    if (!existsSync(wavPath)) return '';

    // whisper-cli writes "<out-prefix>.txt". Using -otxt + -of keeps us from
    // having to scrape the (progress-laden) stdout for the transcript.
    const outPrefix = join(AUDIO_TMP_DIR, stem);
    const args = [
      '-m', bins.modelPath,
      '-f', wavPath,
      '-otxt',
      '-of', outPrefix,
      '-nt', // no timestamps in the output
    ];
    if (config.WHISPER_LANGUAGE && config.WHISPER_LANGUAGE !== 'auto') {
      args.push('-l', config.WHISPER_LANGUAGE);
    }
    if (config.WHISPER_THREADS > 0) {
      args.push('-t', String(config.WHISPER_THREADS));
    }

    await execFileAsync(bins.whisperBin, args, { maxBuffer: 32 * 1024 * 1024 });

    const txtPath = `${outPrefix}.txt`;
    if (!existsSync(txtPath)) return '';
    return readFileSync(txtPath, 'utf8').trim();
  } finally {
    // Clean up everything this call may have written, best-effort.
    for (const path of [srcPath, wavPath, `${join(AUDIO_TMP_DIR, stem)}.txt`]) {
      try {
        if (existsSync(path)) rmSync(path, { force: true });
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

/** Streams a Discord attachment URL to a local file. Returns false on any failure or an empty/oversized body. */
async function downloadAudio(url: string, dest: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AUDIO_BYTES) return false;
    const { writeFileSync } = await import('fs');
    writeFileSync(dest, buffer);
    return true;
  } catch {
    return false;
  }
}

const KNOWN_AUDIO_EXTENSIONS = new Set([
  '.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.webm', '.mp4',
]);

/** Keeps a sane extension on the downloaded temp file so ffmpeg can sniff the container; defaults to .ogg (Discord's voice-note format). */
function safeAudioExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return KNOWN_AUDIO_EXTENSIONS.has(ext) ? ext : '.ogg';
}
