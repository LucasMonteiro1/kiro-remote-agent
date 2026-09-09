import { execFile } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, renameSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { AgentConfig } from './config';

const execFileAsync = promisify(execFile);

/**
 * Self-updater for the daemon and the Kiro IDE extension.
 *
 * How distribution works: a GitHub Actions workflow publishes, for each
 * released tag, one tarball per platform (dist/ + production node_modules
 * with node-pty's native prebuild + the bundled .vsix) plus the standalone
 * .vsix. Devs never clone the repo — an installer drops a release into
 * `~/.kiro-remote-agent/releases/<version>/` and points a `current`
 * symlink at it, keeping their `.env`/thread map in the base dir so they
 * survive updates.
 *
 * This updater periodically asks the GitHub Releases API for the latest
 * version; when a newer one exists it downloads that platform's tarball,
 * extracts it beside the current one, reinstalls the extension, atomically
 * flips the `current` symlink, and exits so the process supervisor
 * (launchd / systemd) relaunches on the new version.
 *
 * Safety properties:
 *  - Only runs under the managed layout (KIRO_REMOTE_MANAGED=1), so a
 *    maintainer's `yarn dev` in the source repo never self-updates.
 *  - Fast-forward only: the symlink is flipped *after* the new release is
 *    downloaded, extracted, and validated, so a bad/partial download can
 *    never take down the working version.
 *  - Pulls from the public repo over HTTPS with no token.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly config: AgentConfig,
    /** Absolute path to the managed base dir (~/.kiro-remote-agent), containing releases/ and the `current` symlink. */
    private readonly homeDir: string,
    /** Current running version (from the release's package.json). */
    private readonly currentVersion: string,
    /** Posts a short status line somewhere the dev will see it (wired to Discord in index.ts). */
    private readonly notify: (text: string) => void,
    private readonly logError: (context: string, err: unknown) => void,
  ) {}

  start(): void {
    // Check shortly after boot (not immediately — let the daemon finish
    // connecting first), then on a fixed interval.
    this.timer = setInterval(() => void this.checkOnce(), this.config.UPDATE_CHECK_INTERVAL_MS);
    setTimeout(() => void this.checkOnce(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async checkOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const latest = await this.fetchLatestRelease();
      if (!latest) return;

      if (!isNewer(latest.version, this.currentVersion)) return;

      const asset = latest.assets.find((a) => a.name === this.tarballName(latest.version));
      if (!asset) {
        this.logError('updater', `no asset for this platform in release ${latest.version} (looked for ${this.tarballName(latest.version)})`);
        return;
      }

      this.notify(`⬆️ Atualização disponível: ${this.currentVersion} → ${latest.version}. Baixando...`);
      await this.applyUpdate(latest.version, asset.url);
    } catch (err) {
      this.logError('updater check', err);
    } finally {
      this.busy = false;
    }
  }

  /** Queries GitHub for the latest release. Returns null on any failure (never throws to the caller). */
  private async fetchLatestRelease(): Promise<{ version: string; assets: { name: string; url: string }[] } | null> {
    const res = await fetch(`https://api.github.com/repos/${this.config.UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kiro-remote-agent-updater' },
    });
    if (!res.ok) {
      this.logError('updater', `releases API returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const version = (body.tag_name ?? '').replace(/^v/, '');
    if (!version) return null;
    const assets = (body.assets ?? [])
      .filter((a): a is { name: string; browser_download_url: string } => !!a.name && !!a.browser_download_url)
      .map((a) => ({ name: a.name, url: a.browser_download_url }));
    return { version, assets };
  }

  /**
   * Downloads, extracts, validates, and activates a new version, then exits
   * so the supervisor relaunches on it. Nothing here mutates the running
   * install until the very last, atomic symlink flip.
   */
  private async applyUpdate(version: string, tarballUrl: string): Promise<void> {
    const releasesDir = join(this.homeDir, 'releases');
    const targetDir = join(releasesDir, version);
    const tmpTar = join(tmpdir(), `kiro-remote-agent-${version}-${Date.now()}.tar.gz`);

    try {
      mkdirSync(releasesDir, { recursive: true });
      // A leftover dir from a previous failed attempt would poison extraction.
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });

      await downloadTo(tarballUrl, tmpTar);
      // Tar is present on macOS and Linux and handles gzip via -z, so we
      // avoid pulling an npm tar dependency into the bundle.
      // --strip-components=1 drops the tarball's top-level kiro-remote-agent/
      // dir so dist/, vendor/, etc. land directly in targetDir — matching
      // where the validation below (and install.sh) expect them. Without it
      // everything extracted under targetDir/kiro-remote-agent/, the
      // dist/index.js check failed, and every hourly attempt rolled back
      // after re-downloading the whole (nowadays ~250MB) tarball.
      await execFileAsync('tar', ['-xzf', tmpTar, '-C', targetDir, '--strip-components=1']);

      // Validate before trusting: the entrypoint must exist, or we refuse
      // to flip the symlink and leave the working version untouched.
      const entry = join(targetDir, 'dist', 'index.js');
      if (!existsSync(entry)) {
        throw new Error(`extracted release missing dist/index.js`);
      }

      await this.reinstallExtension(targetDir, version);

      this.activate(targetDir);
      this.notify(`✅ Atualizado para ${version}. Reiniciando o daemon...`);
      // Give the notify() send a beat to flush over the socket before exit.
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      // Roll back: drop the half-extracted dir; the `current` symlink was
      // never touched, so the running version keeps working.
      rmSync(targetDir, { recursive: true, force: true });
      this.logError('updater apply', err);
      this.notify(`⚠️ Falha ao atualizar para ${version}; mantida a versão ${this.currentVersion}.`);
    } finally {
      try {
        if (existsSync(tmpTar)) unlinkSync(tmpTar);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** Reinstalls the bundled .vsix via the Kiro CLI, if present. Non-fatal: a missing `kiro` just means the dev updates the extension manually. */
  private async reinstallExtension(releaseDir: string, version: string): Promise<void> {
    const vsix = join(releaseDir, 'kiro-remote-bridge.vsix');
    if (!existsSync(vsix)) return;
    try {
      await execFileAsync('kiro', ['--install-extension', vsix]);
      this.notify(`🧩 Extensão atualizada para ${version} — recarregue a janela do Kiro (Cmd/Ctrl+Shift+P → Developer: Reload Window).`);
    } catch (err) {
      this.logError('updater extension', err);
      this.notify(`ℹ️ Não consegui reinstalar a extensão automaticamente (kiro CLI no PATH?). Instale manualmente: ${vsix}`);
    }
  }

  /** Atomically points `current` at the new release directory. */
  private activate(targetDir: string): void {
    const currentLink = join(this.homeDir, 'current');
    const tmpLink = `${currentLink}.tmp-${Date.now()}`;
    symlinkSync(targetDir, tmpLink);
    // rename over an existing symlink is atomic on POSIX, so `current` is
    // never briefly missing.
    renameSync(tmpLink, currentLink);
  }

  private tarballName(version: string): string {
    return `kiro-remote-agent-${version}-${platformTarget()}.tar.gz`;
  }
}

/**
 * Wires up the updater from index.ts, but only when running under the
 * managed install layout — detected via KIRO_REMOTE_MANAGED=1, which the
 * installer sets in the launchd/systemd unit. Returns null (and does
 * nothing) during local `yarn dev`/`yarn start` from the source repo, so
 * the maintainer's checkout is never self-updated.
 */
export function maybeCreateUpdater(
  config: AgentConfig,
  notify: (text: string) => void,
  logError: (context: string, err: unknown) => void,
): Updater | null {
  if (!config.AUTO_UPDATE) return null;
  if (process.env.KIRO_REMOTE_MANAGED !== '1') return null;

  const home = process.env.KIRO_REMOTE_HOME
    ? resolve(process.env.KIRO_REMOTE_HOME)
    : deriveHomeFromModule();
  if (!home) return null;

  const version = readCurrentVersion(home);
  if (!version) return null;

  return new Updater(config, home, version, notify, logError);
}

/** The managed layout is `<home>/releases/<version>/dist/index.js`, so the base dir is three levels up from this module. */
function deriveHomeFromModule(): string | null {
  // __dirname === <home>/releases/<version>/dist
  const releaseDir = dirname(__dirname); // .../<version>
  const releasesDir = dirname(releaseDir); // .../releases
  const home = dirname(releasesDir); // .../<home>
  return existsSync(join(home, 'releases')) ? home : null;
}

function readCurrentVersion(home: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(home, 'current', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Maps Node's platform/arch to the release asset naming used by the CI. */
function platformTarget(): string {
  return `${process.platform}-${process.arch}`;
}

/** Streams a URL to a local file, following the redirect GitHub asset URLs use. */
async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'kiro-remote-agent-updater' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

/** Semver-ish comparison: returns true when `candidate` is strictly greater than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
