#!/usr/bin/env bash
#
# kiro-remote-agent installer (macOS + Linux)
#
# One-command install: downloads the latest release for this platform,
# lays it out under ~/.kiro-remote-agent, walks you through the .env,
# installs the Kiro IDE extension, and registers a boot service that keeps
# the daemon running (and lets it restart itself after auto-updates).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/LucasMonteiro1/kiro-remote-agent/main/install.sh | bash
#
# Re-running it is safe: it installs the newest release alongside any
# existing one and re-points `current` at it, preserving your .env.

set -euo pipefail

REPO="${UPDATE_REPO:-LucasMonteiro1/kiro-remote-agent}"
HOME_DIR="${KIRO_REMOTE_HOME:-$HOME/.kiro-remote-agent}"
RELEASES_DIR="$HOME_DIR/releases"
SERVICE_NAME="com.kiroremote.agent"

log()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

# --- detect platform -------------------------------------------------------

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) die "SO não suportado: $(uname -s). Apenas macOS e Linux por enquanto." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) die "Arquitetura não suportada: $(uname -m)." ;;
  esac
  # Only the platforms the CI publishes an asset for are supported; fail
  # clearly here rather than 404ing on the download later. Mac Intel
  # (darwin-x64) and Linux arm64 are intentionally not built.
  local target="${os}-${arch}"
  case "$target" in
    darwin-arm64|linux-x64) ;;
    *) die "Plataforma não suportada: $target. Suportadas: darwin-arm64 (Apple Silicon), linux-x64." ;;
  esac
  echo "$target"
}

require() { command -v "$1" >/dev/null 2>&1 || die "'$1' é necessário e não está no PATH."; }

# --- prerequisites ---------------------------------------------------------

require curl
require tar
require node
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 é necessário (encontrado $(node -v))."
command -v kiro >/dev/null 2>&1 || warn "'kiro' CLI não encontrado no PATH — a extensão precisará ser instalada manualmente."

TARGET="$(detect_target)"
log "Plataforma detectada: $TARGET"

# --- resolve latest release ------------------------------------------------

log "Consultando o último release de $REPO..."
API="https://api.github.com/repos/$REPO/releases/latest"
RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
  || die "Falha ao consultar a API de releases do GitHub."

VERSION="$(printf '%s' "$RELEASE_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"v?([^"]+)".*/\1/')"
[ -n "$VERSION" ] || die "Não consegui determinar a versão do último release (nenhum release publicado ainda?)."

TARBALL="kiro-remote-agent-${VERSION}-${TARGET}.tar.gz"
ASSET_URL="$(printf '%s' "$RELEASE_JSON" \
  | grep -o "https://[^\"]*${TARBALL}" | head -1)"
[ -n "$ASSET_URL" ] || die "Release $VERSION não tem asset para $TARGET ($TARBALL)."

log "Instalando versão $VERSION"

# --- download + extract ----------------------------------------------------

TARGET_DIR="$RELEASES_DIR/$VERSION"
mkdir -p "$RELEASES_DIR"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

TMP_TAR="$(mktemp -t kiro-remote-agent.XXXXXX).tar.gz"
trap 'rm -f "$TMP_TAR"' EXIT

log "Baixando $TARBALL..."
curl -fsSL -o "$TMP_TAR" "$ASSET_URL" || die "Falha no download do release."
# The tarball has a top-level kiro-remote-agent/ dir; strip it.
tar -xzf "$TMP_TAR" -C "$TARGET_DIR" --strip-components=1 \
  || die "Falha ao extrair o release."
[ -f "$TARGET_DIR/dist/index.js" ] || die "Release extraído inválido (dist/index.js ausente)."

# --- .env (interactive on first install, preserved afterwards) -------------

ENV_FILE="$HOME_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  log ".env já existe em $ENV_FILE — mantido como está."
else
  log "Configuração inicial (.env). Deixe em branco para usar o padrão quando houver."
  # Only prompt when running interactively; piped installs must set these
  # via env vars or edit the .env afterwards.
  if [ -t 0 ]; then
    read -r -p "DISCORD_BOT_TOKEN: " IN_TOKEN
    read -r -p "DISCORD_FORUM_CHANNEL_ID: " IN_FORUM
    read -r -p "KIRO_PROJECT_DIR (projeto onde o kiro-cli roda): " IN_PROJECT
  else
    IN_TOKEN="${DISCORD_BOT_TOKEN:-}"
    IN_FORUM="${DISCORD_FORUM_CHANNEL_ID:-}"
    IN_PROJECT="${KIRO_PROJECT_DIR:-}"
    warn "Instalação não-interativa: preencha $ENV_FILE manualmente se algum valor ficou vazio."
  fi

  # A strong shared secret for the local hub, generated for the dev.
  if command -v openssl >/dev/null 2>&1; then
    GEN_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  else
    GEN_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')"
  fi

  cp "$TARGET_DIR/.env.example" "$ENV_FILE"
  # Fill in the values the installer knows.
  node - "$ENV_FILE" "$IN_TOKEN" "$IN_FORUM" "$IN_PROJECT" "$GEN_SECRET" <<'NODE'
const fs = require('fs');
const [file, token, forum, project, secret] = process.argv.slice(2);
let text = fs.readFileSync(file, 'utf8');
const set = (key, val) => {
  if (!val) return;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${val}`) : `${text}\n${key}=${val}`;
};
set('DISCORD_BOT_TOKEN', token);
set('DISCORD_FORUM_CHANNEL_ID', forum);
set('KIRO_PROJECT_DIR', project);
set('HUB_SHARED_SECRET', secret);
fs.writeFileSync(file, text);
NODE
  log ".env criado em $ENV_FILE (HUB_SHARED_SECRET gerado automaticamente)."
  warn "Confira $ENV_FILE — ajuste KIRO_PROJECT_DIR e demais valores se necessário."
fi

# --- activate: point `current` at the freshly installed version -----------

ln -sfn "$TARGET_DIR" "$HOME_DIR/current"
log "Versão $VERSION ativada (current -> releases/$VERSION)."

# --- install the Kiro IDE extension ---------------------------------------

if command -v kiro >/dev/null 2>&1 && [ -f "$TARGET_DIR/kiro-remote-bridge.vsix" ]; then
  log "Instalando a extensão Kiro Remote Bridge..."
  kiro --install-extension "$TARGET_DIR/kiro-remote-bridge.vsix" \
    && log "Extensão instalada. Recarregue a janela do Kiro (Cmd/Ctrl+Shift+P → Developer: Reload Window)." \
    || warn "Falha ao instalar a extensão automaticamente. Instale manualmente: $TARGET_DIR/kiro-remote-bridge.vsix"
  warn "Configure em settings.json do Kiro: kiroRemoteBridge.hubSecret = o valor de HUB_SHARED_SECRET em $ENV_FILE"
else
  warn "Extensão não instalada automaticamente (kiro CLI ausente). Arquivo: $TARGET_DIR/kiro-remote-bridge.vsix"
fi

# --- register a boot service so the daemon stays up and can self-restart ---

NODE_BIN="$(command -v node)"

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${HOME_DIR}/current/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${HOME_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KIRO_REMOTE_MANAGED</key><string>1</string>
    <key>KIRO_REMOTE_HOME</key><string>${HOME_DIR}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME_DIR}/agent.out.log</string>
  <key>StandardErrorPath</key><string>${HOME_DIR}/agent.err.log</string>
</dict>
</plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"
  log "LaunchAgent registrado ($plist). O daemon sobe agora e no login."
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/kiro-remote-agent.service"
  mkdir -p "$unit_dir"
  cat > "$unit" <<UNIT
[Unit]
Description=kiro-remote-agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${HOME_DIR}
Environment=KIRO_REMOTE_MANAGED=1
Environment=KIRO_REMOTE_HOME=${HOME_DIR}
ExecStart=${NODE_BIN} ${HOME_DIR}/current/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now kiro-remote-agent.service
  # `enable --now` starts the unit only if it was stopped; on a re-install
  # over an already-running service it's a no-op, leaving the old process
  # (and thus the old code) running even though `current` now points at the
  # new release. An explicit restart guarantees the daemon relaunches on the
  # freshly activated version. (launchd above avoids this via unload+load.)
  systemctl --user restart kiro-remote-agent.service
  # Keep the daemon running when you're not logged in (best-effort).
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "Sem 'linger' — o daemon só roda enquanto você estiver logado."
  log "Serviço systemd (user) registrado e iniciado."
}

case "$(uname -s)" in
  Darwin) install_launchd ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      install_systemd
    else
      warn "systemd não disponível. Rode manualmente: KIRO_REMOTE_MANAGED=1 KIRO_REMOTE_HOME=$HOME_DIR $NODE_BIN $HOME_DIR/current/dist/index.js"
    fi
    ;;
esac

log "Instalação concluída — versão $VERSION."
echo
echo "  Config:   $ENV_FILE"
echo "  Logs:     $HOME_DIR/agent.out.log / agent.err.log"
echo "  Auto-update ligado: novas versões são aplicadas sozinhas."
