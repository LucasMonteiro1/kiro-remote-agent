# kiro-remote-agent

Daemon local que roda no seu PC (do trabalho, por exemplo) e faz a ponte
entre uma sessão interativa do `kiro-cli` e o seu celular — sem depender
de polling num banco de dados remoto.

Faz parte de um par de repositórios:

- **kiro-remote-agent** (este repo) — roda no seu PC. Conversa com o
  `kiro-cli` local **e** hospeda o hub (servidor WebSocket que guarda o
  estado do chat em memória e empurra eventos para quem estiver conectado).
- **[kiro-remote-relay](https://github.com/LucasMonteiro1/kiro-remote-relay)** —
  roda no Vercel. Hoje só cuida do login por senha e emite um token de
  curta duração para o celular se conectar direto no hub.

## Como funciona

1. Sobe o **hub**: um servidor WebSocket local (`ws://127.0.0.1:HUB_PORT`,
   porta padrão `8787`) que mantém o histórico do chat em memória (até 2000
   eventos, igual antes) e autentica dois tipos de conexão:
   - **extension**: a extensão Kiro Remote Bridge, uma por janela aberta do
     Kiro IDE — conecta localmente, com um segredo estático
     (`HUB_SHARED_SECRET`).
   - **owner**: o celular/navegador — conecta através de um túnel Cloudflare
     (`cloudflared`), com um token JWT de curta duração emitido pelo relay
     depois do login por senha.
2. Inicia (ou retoma) uma sessão `kiro-cli chat` **interativa** dentro de um
   pseudo-terminal (via `node-pty`) — não usa o modo `--no-interactive`,
   justamente porque esse modo não pausa para pedir aprovação de tools.
3. Toda mensagem enviada pelo celular chega **instantaneamente** pelo
   WebSocket (sem polling) e é digitada na sessão do `kiro-cli`.
4. Observa a saída do `kiro-cli` no PTY: quando o texto bate com um padrão de
   prompt de aprovação (`APPROVAL_PROMPT_REGEX`), publica um
   `approval_request` no hub — isso aparece no celular como um card com
   botões **Aprovar / Sempre / Recusar**, na hora.
5. Quando você responde no celular, o daemon recebe a decisão via WebSocket
   e envia as teclas correspondentes (`y`, `n`, etc.) de volta para o PTY.
6. Quando o `kiro-cli` fica "quieto" por um tempo (`IDLE_MS_BEFORE_TURN_COMPLETE`),
   considera o turno concluído e publica o texto acumulado como resposta do
   assistente — que o celular já recebe instantaneamente.
7. (Opcional) Se `DATABASE_URL` estiver configurado, o hub faz um backup
   periódico (a cada 15s, em lote) do log de eventos num Postgres/Neon —
   só para durabilidade entre reinícios do daemon, não no caminho crítico
   de leitura/escrita.

O código, credenciais, MCPs e terminal continuam **100% no seu PC**. O hub
e o celular só veem texto de mensagens e prompts.

## Por que isso é mais barato/rápido que antes

O design anterior fazia todo mundo (celular, daemon, cada janela do Kiro
IDE aberta) fazer polling HTTPS num Postgres remoto a cada poucos segundos —
dezenas de queries por minuto mesmo com ninguém digitando, e latência de
vários segundos entre enviar e receber uma mensagem.

Agora o hub roda dentro deste próprio daemon: estado em memória, eventos
empurrados na hora via WebSocket, zero polling. O Postgres (se configurado)
só recebe um lote de escritas a cada 15s, para durabilidade — não para
leitura, nem no caminho de nenhuma mensagem.

## ⚠️ Aviso importante — calibração necessária

O formato exato dos prompts de aprovação do `kiro-cli` (o texto que ele
imprime pedindo "y/n" antes de rodar uma tool) **não é documentado
publicamente**. Os valores padrão de `APPROVAL_PROMPT_REGEX`,
`APPROVE_KEYSTROKES`, `DENY_KEYSTROKES` e `APPROVE_ALWAYS_KEYSTROKES` em
`.env.example` são heurísticos.

**Antes de confiar no fluxo de aprovação**, faça um teste controlado:

1. Rode o daemon com `DEBUG_LOG_PATH` apontando para um arquivo local.
2. Peça, pelo celular, algo que dispare um prompt de aprovação (ex: pedir
   pro Kiro editar um arquivo).
3. Abra o `DEBUG_LOG_PATH` e veja exatamente o texto/teclas que o `kiro-cli`
   espera.
4. Ajuste `APPROVAL_PROMPT_REGEX` e as `*_KEYSTROKES` no `.env` conforme o
   que você observou.

Até calibrar isso, trate qualquer aprovação "silenciosa" (que não gerou
card no celular) com desconfiança — pode ser que a regex não tenha
detectado o prompt.

## Pré-requisitos

- Node.js >= 20
- [`kiro-cli`](https://kiro.dev/docs/getting-started/installation) instalado
  e autenticado (`kiro-cli` deve funcionar manualmente no terminal antes de
  usar este daemon).
- Uma `KIRO_API_KEY` válida (requer plano Pro ou superior) para autenticação
  não-interativa — ver [docs de autenticação](https://kiro.dev/docs/getting-started/authentication).
- Um deploy do [kiro-remote-relay](https://github.com/LucasMonteiro1/kiro-remote-relay)
  já rodando (só para login/token — não precisa mais de fila/Postgres pro chat).
- `cloudflared` instalado (ver seção abaixo) para expor o hub publicamente,
  de graça, sem abrir porta no roteador.
- Ferramentas de build nativas (o `node-pty` compila um binário nativo):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential` + `python3`
  - Windows: `windows-build-tools` ou Visual Studio Build Tools

## Setup

```bash
cp .env.example .env
# edite .env com os valores reais (ver tabela abaixo)

yarn install
yarn build
yarn start
```

Você deve ver no log:

```
[hub] listening on ws://127.0.0.1:8787
```

> **Nota (macOS):** o binário pré-compilado do `node-pty` (`spawn-helper`)
> às vezes perde a permissão de execução após o `yarn install`, causando o
> erro `posix_spawnp failed`. Um script `postinstall` já corrige isso
> automaticamente; se ainda assim ocorrer, rode:
> ```bash
> chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
> ```

Para desenvolvimento (com reload via tsx, sem precisar de build):

```bash
yarn dev
```

### Variáveis de ambiente

| Variável                        | Descrição                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `HUB_PORT`                       | Porta local do servidor WebSocket do hub (padrão `8787`)                      |
| `HUB_SHARED_SECRET`              | Segredo usado pela extensão do Kiro IDE para autenticar no hub                 |
| `HUB_TOKEN_SECRET`               | Deve ser **idêntico** ao configurado no `kiro-remote-relay` — assina o token do celular |
| `HOST_LABEL`                     | Nome amigável exibido no celular (ex: `work-macbook`)                         |
| `DATABASE_URL`                   | (Opcional) Neon/Postgres só para backup periódico do log de eventos            |
| `KIRO_CLI_BIN`                    | Caminho do binário `kiro-cli`. Se for rodar via `pm2`/`launchd` (PATH restrito), use o caminho absoluto (ex: `/Users/voce/.local/bin/kiro-cli`) |
| `KIRO_PROJECT_DIR`                | Diretório do projeto onde o `kiro-cli` deve rodar                             |
| `KIRO_SESSION_ID`                 | (Opcional) ID de sessão específica a retomar; se vazio, usa a mais recente     |
| `KIRO_TRUST_TOOLS`                | Categorias de tool pré-aprovadas (ex: `read,grep`); vazio = tudo passa por aprovação manual pelo celular |
| `KIRO_API_KEY`                    | Chave de API do Kiro para autenticação automatizada                           |
| `APPROVAL_PROMPT_REGEX`           | Regex para detectar prompts de aprovação — **calibrar** (ver aviso acima)      |
| `APPROVE_KEYSTROKES` / `DENY_KEYSTROKES` / `APPROVE_ALWAYS_KEYSTROKES` | Teclas enviadas ao PTY para cada decisão — **calibrar**      |
| `IDLE_MS_BEFORE_TURN_COMPLETE`    | Tempo de silêncio (ms) para considerar um turno concluído                     |
| `DEBUG_LOG_PATH`                  | Arquivo de log com saída crua do PTY (contém trechos da conversa — não commitar) |

## Cloudflare Tunnel — expor o hub sem abrir porta (de graça)

Isso substitui a antiga necessidade de o celular fazer polling num servidor
público. Agora é o hub (rodando no seu PC) que precisa ficar alcançável de
fora — sem abrir porta no roteador, usando uma conexão de **saída** do
`cloudflared`.

### 1. Instalar o `cloudflared`

```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### 2. Opção rápida (sem domínio próprio) — Quick Tunnel

Bom para testar rapidamente; a URL muda a cada reinício.

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

O terminal vai mostrar algo como:

```
https://random-words-here.trycloudflare.com
```

Use a versão `wss://` desse hostname como `HUB_PUBLIC_URL` no
`kiro-remote-relay` (troque `https://` por `wss://`).

### 3. Opção estável (com domínio próprio no Cloudflare) — Named Tunnel

Melhor para uso contínuo: URL fixa, e pode rodar como serviço em background.

```bash
# login (abre o navegador para autenticar na sua conta Cloudflare)
cloudflared tunnel login

# cria um túnel nomeado
cloudflared tunnel create kiro-hub

# aponta um subdomínio seu para ele (precisa ter o domínio já no Cloudflare)
cloudflared tunnel route dns kiro-hub kiro-hub.seudominio.com
```

Crie `~/.cloudflared/config.yml`:

```yaml
tunnel: kiro-hub
credentials-file: /Users/voce/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: kiro-hub.seudominio.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Rode:

```bash
cloudflared tunnel run kiro-hub
```

`HUB_PUBLIC_URL` no `kiro-remote-relay` fica `wss://kiro-hub.seudominio.com`.

Para deixar rodando permanentemente em background (macOS/Linux):

```bash
sudo cloudflared service install
```

### Notas

- O WebSocket é suportado nativamente pelo Cloudflare Tunnel — não precisa
  de configuração extra além do `ingress` acima.
- Enquanto o `cloudflared` e o daemon estiverem rodando, o chat funciona.
  Se o PC dormir ou o `cloudflared` cair, o celular perde a conexão e
  reconecta automaticamente assim que ambos voltarem.
- Isso é 100% gratuito no plano free da Cloudflare (Quick Tunnels e Named
  Tunnels com domínio próprio não têm custo).

## Extensão Kiro Remote Bridge (Kiro IDE)

A extensão em `ide-extension/` conecta diretamente no hub local
(`ws://127.0.0.1:8787` por padrão — mesma máquina, sem precisar de túnel).
Configure em `settings.json` do Kiro IDE:

```json
{
  "kiroRemoteBridge.enabled": true,
  "kiroRemoteBridge.hubUrl": "ws://127.0.0.1:8787",
  "kiroRemoteBridge.hubSecret": "o-mesmo-valor-de-HUB_SHARED_SECRET"
}
```

Build da extensão:

```bash
cd ide-extension
yarn install
yarn build
```

## Rodando em background

Recomenda-se manter isso rodando de forma persistente enquanto você
trabalha (o daemon **e** o `cloudflared`). Algumas opções:

```bash
# pm2
npm install -g pm2
pm2 start dist/index.js --name kiro-remote-agent
pm2 start "cloudflared tunnel run kiro-hub" --name kiro-cloudflared

# ou simplesmente em terminais dedicados com nohup
nohup yarn start > agent.out.log 2>&1 &
nohup cloudflared tunnel run kiro-hub > cloudflared.out.log 2>&1 &
```

## Segurança

- O hub aceita duas categorias de conexão: `extension` (segredo estático,
  só local) e `owner` (token JWT de curta duração, só válido por 5 minutos
  desde que emitido pelo relay). Sem um desses, a conexão é fechada.
- O `HUB_SHARED_SECRET` dá controle completo sobre o que este daemon pode
  fazer no seu PC (digitar mensagens na sua sessão do Kiro). Trate-o como
  uma senha — nunca commite o `.env`, nunca coloque em capturas de tela.
- Por padrão (`KIRO_TRUST_TOOLS` vazio), **toda** chamada de tool passa por
  aprovação manual, igual no Kiro IDE. Só relaxe isso (adicionando
  categorias em `KIRO_TRUST_TOOLS`) se tiver certeza do que está liberando.
- `DEBUG_LOG_PATH` pode conter trechos da sua conversa/código em texto
  puro — já está no `.gitignore`, mas delete o arquivo depois de calibrar a
  regex de aprovação.
- O Cloudflare Tunnel expõe o hub publicamente, mas o hub em si continua
  exigindo autenticação (token/segredo) para qualquer coisa alem do
  handshake inicial de `hello`.

## Limitações conhecidas

- Uma sessão do `kiro-cli` só pode estar ativa em um processo por vez. Se
  você abrir a mesma sessão no Kiro IDE enquanto este daemon estiver rodando
  com ela, um dos dois vai falhar ao conectar.
- A detecção de "fim de turno" é por heurística de silêncio no PTY, não por
  um sinal explícito do `kiro-cli` — turnos muito longos com pausas no meio
  podem ser fragmentados em múltiplas mensagens no celular.
- O hub roda em memória: se o daemon reiniciar, o histórico do chat em RAM
  se perde (a menos que `DATABASE_URL` esteja configurado para backup
  periódico — mesmo assim, os últimos segundos antes de um crash podem não
  ter sido persistidos ainda).
- O PC do trabalho e o `cloudflared` precisam estar ligados para o celular
  conseguir conversar com o agente — isso já era verdade antes para
  *responder*, mas agora também é necessário para *ver* o histórico, já que
  ele não vive mais num relay remoto.
- Sem suporte a anexos/imagens — apenas texto.
