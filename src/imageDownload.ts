import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import type { MessageAttachment } from './hubProtocol';

/** Where downloaded Discord image attachments are cached for kiro-cli / the IDE to read. */
const IMAGE_TMP_DIR = join(tmpdir(), 'kiro-remote-images');
/** Skip absurdly large downloads; Discord's own attachment cap is well under this for images. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Downloads a Discord image attachment to a local temp file and returns its
 * absolute path, or null if the download fails.
 *
 * Discord attachment URLs are public but short-lived, so this is called at
 * delivery time rather than lazily. The filename is randomized (keeping only
 * the original extension) so two images named "image.png" can't clobber each
 * other, and so a hostile filename can't traverse out of the temp dir.
 */
export async function downloadAttachment(attachment: MessageAttachment): Promise<string | null> {
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    mkdirSync(IMAGE_TMP_DIR, { recursive: true });
    const ext = safeExtension(attachment.filename, attachment.contentType);
    const path = join(IMAGE_TMP_DIR, `${randomUUID()}${ext}`);
    writeFileSync(path, buffer);
    return path;
  } catch {
    return null;
  }
}

/**
 * Downloads all attachments and returns the local paths that succeeded.
 * Individual failures are skipped rather than failing the whole message.
 */
export async function downloadAttachments(attachments: MessageAttachment[]): Promise<string[]> {
  const results = await Promise.all(attachments.map((a) => downloadAttachment(a)));
  return results.filter((path): path is string => path !== null);
}

/**
 * Builds the prompt text delivered to Kiro, appending an instruction that
 * lists the local image paths so Kiro reads them with its file/image tools.
 * Returns the original text unchanged when there are no images.
 */
export function composePromptWithImages(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text;
  const lines = imagePaths.map((p) => `- ${p}`).join('\n');
  const label =
    imagePaths.length === 1
      ? 'Imagem anexada (leia o arquivo local para analisá-la):'
      : 'Imagens anexadas (leia os arquivos locais para analisá-las):';
  const body = `${label}\n${lines}`;
  return text ? `${text}\n\n${body}` : body;
}

const KNOWN_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);

function safeExtension(filename: string, contentType?: string): string {
  const ext = extname(filename).toLowerCase();
  if (KNOWN_IMAGE_EXTENSIONS.has(ext)) return ext;
  // Fall back to the content type's subtype when the filename has no useful
  // extension (e.g. Discord sometimes serves "unknown").
  const subtype = contentType?.split('/')[1]?.toLowerCase();
  if (subtype) {
    const fromType = `.${subtype === 'jpeg' ? 'jpg' : subtype}`;
    if (KNOWN_IMAGE_EXTENSIONS.has(fromType)) return fromType;
  }
  return '.png';
}
