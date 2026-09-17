# Kiro Remote — Runbook

O **Kiro Remote** espelha suas sessões do Kiro no seu servidor do Discord. Ele
roda como um daemon em background (launchd `com.kiroremote.agent`) que, para cada
sessão, invoca o `kiro-cli` e envia a saída para o **chat padrão** do seu Discord.

## Sintoma: "parou de enviar sessões pro Discord"

Quase sempre a causa é o **`kiro-cli` deslogado**. A autenticação é SSO (IAM
Identity Center) e **expira** de tempos em tempos — quando expira, para de espelhar
para todo mundo mais ou menos ao mesmo tempo.

O que confunde: **o bot do Discord continua online**. Só que, sem login no
`kiro-cli`, nenhuma sessão nova é postada. É uma falha silenciosa.

### Diagnóstico rápido

```bash
kiro-cli whoami
```

- `Not logged in` → é isso. Siga a correção abaixo.
- `Logged in with IAM Identity Center...` → o login está ok; veja "Outras causas".

## Correção (o caso comum)

```bash
kiro-cli login

# reinicie o daemon — macOS:
launchctl kickstart -k gui/$(id -u)/com.kiroremote.agent
# Linux (systemd):
systemctl --user restart kiro-remote-agent.service
```

Depois confirme:

```bash
kiro-cli whoami          # deve mostrar sua conta
```

Abra uma sessão no Kiro e verifique se voltou a aparecer no seu chat do Discord.

## Monitor de saúde (aviso automático)

Para não depender de perceber a falha "na mão", há um health-check que roda a cada
5 min via launchd (`com.kiroremote.healthcheck`) e **avisa no seu próprio chat do
Discord** quando o `kiro-cli` cai (🔴) e quando volta (✅). Ele só posta na
**mudança** de estado — não fica repetindo.

- Script: `~/.kiro-remote-agent/healthcheck.sh`
- Serviço: `~/Library/LaunchAgents/com.kiroremote.healthcheck.plist`
- Log: `~/.kiro-remote-agent/healthcheck.log`
- Estado atual: `~/.kiro-remote-agent/healthcheck-state.json`

Ele reusa o bot token do daemon (do `.env`) e posta no seu chat padrão
(`threads.__default__` do `discord-threads.json`) — nada é postado em canal
compartilhado da tribo; cada dev recebe no seu próprio servidor.

### Comandos úteis do monitor

```bash
# rodar na hora
launchctl kickstart -k gui/$(id -u)/com.kiroremote.healthcheck

# ver o log
tail -f ~/.kiro-remote-agent/healthcheck.log

# desativar / reativar
launchctl bootout  gui/$(id -u) ~/Library/LaunchAgents/com.kiroremote.healthcheck.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kiroremote.healthcheck.plist
```

## Outras causas (se `whoami` já estiver logado)

1. **Daemon parado.** Confirme e reinicie:
   ```bash
   launchctl list | grep com.kiroremote.agent
   launchctl kickstart -k gui/$(id -u)/com.kiroremote.agent
   tail -n 30 ~/.kiro-remote-agent/agent.out.log   # deve logar hub + discord login
   tail -n 30 ~/.kiro-remote-agent/agent.err.log
   ```
2. **Bridge da IDE desconectado do hub.** O daemon escuta em `ws://127.0.0.1:8787`.
   Verifique se a extensão Kiro Remote Bridge está conectada:
   ```bash
   lsof -nP -iTCP:8787 | grep ESTABLISHED
   ```
3. **Erro do self-updater** no `agent.err.log` (`extracted release missing
   dist/index.js`): historicamente foi ruído de release quebrada e se resolveu com a
   versão seguinte. Só investigue se for recente e o `current ->` estiver apontando
   para uma release sem `dist/index.js`.

## Redução de reincidência (nota pra tribo)

A raiz é o login SSO que expira. Enquanto o `kiro-cli` depender de login por
browser, isso vai voltar — o monitor agora torna a falha **visível** em vez de
silenciosa, mas não elimina a causa. Se o time quiser eliminar de vez, avaliar
autenticação headless mais durável (ex.: `KIRO_API_KEY`, previsto no `.env.example`,
que precisa de plano Pro).
