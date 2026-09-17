#!/usr/bin/env bash
#
# kiro-remote-agent — health check
#
# Motivo: o daemon (com.kiroremote.agent) espelha as sessões do Kiro no Discord
# invocando `kiro-cli`. Quando o login do kiro-cli expira (SSO IAM Identity
# Center), o bot do Discord CONTINUA online, mas nenhuma sessão é postada — uma
# falha silenciosa. Este check roda de fora do daemon (é o daemon/cli que
# quebra), detecta o estado de login e AVISA no Discord na transição de estado.
#
# Idempotente: só posta na virada logado->deslogado (alerta) e deslogado->logado
# (recuperado). Enquanto o estado não muda, não posta nada (não faz flood).
#
# Roda via launchd com.kiroremote.healthcheck. Não imprime segredos.

set -uo pipefail

HOME_DIR="${KIRO_REMOTE_HOME:-$HOME/.kiro-remote-agent}"
ENV_FILE="$HOME_DIR/.env"
STATE_FILE="$HOME_DIR/healthcheck-state.json"
LOG_FILE="$HOME_DIR/healthcheck.log"

# O alerta vai para o CHAT PADRÃO do próprio dev (o "__default__" do
# discord-threads.json mantido pelo daemon), não para um canal compartilhado.
# Cada dev tem o seu servidor Discord; nada é postado em canal de tribo.
THREAD_MAP_FILE="$HOME_DIR/discord-threads.json"

DISCORD_API="https://discord.com/api/v10"
CURL="/usr/bin/curl"
JQ="$(command -v jq || echo /opt/homebrew/bin/jq)"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

# --- Carrega o .env do daemon (reusa o bot token e o canal já configurados) ---
if [[ ! -f "$ENV_FILE" ]]; then
  log "ERRO: .env não encontrado em $ENV_FILE — nada a fazer."
  exit 0
fi
# Lê apenas as chaves que precisamos, sem dar source no arquivo inteiro
# (evita executar conteúdo arbitrário do .env).
read_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- ; }

DISCORD_BOT_TOKEN="$(read_env DISCORD_BOT_TOKEN)"
HOST_LABEL="$(read_env HOST_LABEL)"; HOST_LABEL="${HOST_LABEL:-$(hostname -s)}"
KIRO_CLI_BIN="$(read_env KIRO_CLI_BIN)"; KIRO_CLI_BIN="${KIRO_CLI_BIN:-kiro-cli}"

# Caminho do mapa de threads mantido pelo daemon (pode ser relativo ao HOME_DIR).
THREAD_MAP_PATH="$(read_env DISCORD_THREAD_MAP_PATH)"; THREAD_MAP_PATH="${THREAD_MAP_PATH:-./discord-threads.json}"
case "$THREAD_MAP_PATH" in
  /*) THREAD_MAP_FILE="$THREAD_MAP_PATH" ;;
  *)  THREAD_MAP_FILE="$HOME_DIR/${THREAD_MAP_PATH#./}" ;;
esac

# --- Detecta o estado de login do kiro-cli ---
# whoami sai 0 nos dois casos, então casamos no texto.
WHOAMI_OUT="$("$KIRO_CLI_BIN" whoami 2>&1)"
if printf '%s' "$WHOAMI_OUT" | grep -qi "not logged in"; then
  CURRENT="down"
elif printf '%s' "$WHOAMI_OUT" | grep -qi "logged in"; then
  CURRENT="up"
else
  # Saída inesperada (rede, binário mudou): não trata como deslogado pra não
  # gerar alarme falso; registra e sai.
  log "estado indeterminado — whoami não casou logado/deslogado. Ignorando."
  exit 0
fi

# --- Estado anterior ---
PREVIOUS="unknown"
if [[ -f "$STATE_FILE" ]]; then
  PREVIOUS="$("$JQ" -r '.state // "unknown"' "$STATE_FILE" 2>/dev/null || echo unknown)"
fi

# Persiste o estado atual sempre (com timestamp).
printf '{"state":"%s","host":"%s","ts":"%s"}\n' \
  "$CURRENT" "$HOST_LABEL" "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$STATE_FILE"

# Sem mudança de estado => nada a fazer (silêncio proposital).
if [[ "$CURRENT" == "$PREVIOUS" ]]; then
  exit 0
fi

# Primeira execução (sem estado anterior): registra o baseline sem postar.
# Só alertaríamos numa transição real depois disso.
if [[ "$PREVIOUS" == "unknown" ]]; then
  log "baseline inicial: estado=$CURRENT (sem alerta)."
  exit 0
fi

log "TRANSIÇÃO $PREVIOUS -> $CURRENT"

# Comando de restart do daemon, específico do SO.
if [[ "$(uname -s)" == "Darwin" ]]; then
  RESTART_CMD="launchctl kickstart -k gui/\$(id -u)/com.kiroremote.agent"
else
  RESTART_CMD="systemctl --user restart kiro-remote-agent.service"
fi

# --- Monta a mensagem da transição ---
if [[ "$CURRENT" == "down" ]]; then
  CONTENT="🔴 **Kiro Remote parado em \`${HOST_LABEL}\`**
O \`kiro-cli\` está **deslogado** — o espelhamento de sessões no Discord parou (o bot continua online, mas nada novo é postado).

**Como resolver:**
\`\`\`
kiro-cli login
${RESTART_CMD}
\`\`\`
Depois confirme com \`kiro-cli whoami\`."
else
  CONTENT="✅ **Kiro Remote recuperado em \`${HOST_LABEL}\`** — \`kiro-cli\` logado, espelhamento de sessões normalizado."
fi

# --- Descobre o chat padrão do dev (o "__default__" que o daemon mantém) ---
# Cada dev tem o seu próprio servidor Discord; o alerta vai para o SEU chat
# padrão, o mesmo onde as sessões são espelhadas. Nada em canal de tribo.
DEFAULT_CHANNEL_ID=""
if [[ -f "$THREAD_MAP_FILE" ]]; then
  DEFAULT_CHANNEL_ID="$("$JQ" -r '.threads.__default__ // ""' "$THREAD_MAP_FILE" 2>/dev/null || echo "")"
fi

# --- Sem credencial/destino: registra localmente e sai (não falha) ---
if [[ -z "$DISCORD_BOT_TOKEN" ]]; then
  log "AVISO: DISCORD_BOT_TOKEN ausente — alerta não enviado. Conteúdo: $CONTENT"
  exit 0
fi
if [[ -z "$DEFAULT_CHANNEL_ID" ]]; then
  log "AVISO: chat padrão (__default__) não encontrado em $THREAD_MAP_FILE — alerta não enviado. Conteúdo: $CONTENT"
  exit 0
fi

# --- Posta a mensagem no chat padrão do dev ---
auth_header="Authorization: Bot ${DISCORD_BOT_TOKEN}"
msg_payload="$("$JQ" -n --arg msg "$CONTENT" '{content:$msg}')"
resp="$("$CURL" -s -X POST -H "$auth_header" -H "Content-Type: application/json" \
  -d "$msg_payload" "$DISCORD_API/channels/$DEFAULT_CHANNEL_ID/messages")"
posted="$(printf '%s' "$resp" | "$JQ" -r '.id // ""')"
if [[ -z "$posted" || "$posted" == "null" ]]; then
  log "ERRO ao postar no chat padrão $DEFAULT_CHANNEL_ID. Resposta: $(printf '%s' "$resp" | "$JQ" -c '{code,message}' 2>/dev/null || echo "$resp")"
  exit 0
fi
log "alerta postado no chat padrão $DEFAULT_CHANNEL_ID ($PREVIOUS -> $CURRENT)"

exit 0
