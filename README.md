# kiro-remote-agent

Daemon local que roda no seu PC (do trabalho, por exemplo) e faz a ponte
entre uma sessão interativa do `kiro-cli` e um bot do Discord — para você
continuar a conversa pelo celular usando o próprio app do Discord, sem
nenhuma infraestrutura própria (sem relay, sem túnel, sem banco de dados).

## Instalação para devs (recomendado)

Você **não precisa clonar este repositório**. A instalação é um comando só,
que baixa o último release pronto, configura tudo e deixa o daemon rodando
em segundo plano — inclusive se atualizando sozinho quando sair uma versão
nova.

### 1. Crie seu bot e servidor no Discord (uma vez)

Cada dev usa o **seu próprio** bot e servidor Discord. Siga o passo a passo
em [Setup do Discord](#setup-do-discord) abaixo — ao final você terá o
`DISCORD_BOT_TOKEN` e o `DISCORD_FORUM_CHANNEL_ID`.

### 2. Rode o instalador

Pré-requisitos: **Node ≥ 20** e o **`kiro` CLI** no PATH (você já tem se usa
o Kiro IDE).

```bash
curl -fsSL https://raw.githubusercontent.com/LucasMonteiro1/kiro-remote-agent/main/install.sh | bash
```

O instalador (macOS e Linux):

- baixa o release da sua plataforma para `~/.kiro-remote-agent/`;
- pergunta `DISCORD_BOT_TOKEN`, `DISCORD_FORUM_CHANNEL_ID` e
  `KIRO_PROJECT_DIR`, e **gera o `HUB_SHARED_SECRET` sozinho**;
- instala a extensão **Kiro Remote Bridge** no Kiro IDE;
- registra um serviço de boot (launchd no macOS / systemd no Linux) para o
  daemon subir sozinho e reiniciar após atualizações.

Depois, no `settings.json` do Kiro IDE, aponte a extensão para o mesmo
segredo gerado (o instalador mostra o caminho do `.env`):

```json
{
  "kiroRemoteBridge.enabled": true,
  "kiroRemoteBridge.hubUrl": "ws://127.0.0.1:8787",
  "kiroRemoteBridge.hubSecret": "o-valor-de-HUB_SHARED_SECRET-do-seu-.env"
}
```

Recarregue a janela do Kiro (`Cmd/Ctrl+Shift+P` → **Developer: Reload
Window**) e pronto — abra o Discord no celular e comece a conversar.

### Atualizações (automáticas)

O daemon verifica novas versões periodicamente e se atualiza sozinho —
baixa o novo release, reinstala a extensão, e reinicia. Quando a extensão
for atualizada, ele avisa no Discord para você recarregar a janela do Kiro.
Nada a fazer manualmente.

Para pausar as atualizações, coloque `AUTO_UPDATE=false` no seu
`~/.kiro-remote-agent/.env` e reinicie o serviço.

### Desinstalar

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.kiroremote.agent.plist
rm ~/Library/LaunchAgents/com.kiroremote.agent.plist

# Linux
systemctl --user disable --now kiro-remote-agent.service
rm ~/.config/systemd/user/kiro-remote-agent.service

# ambos
rm -rf ~/.kiro-remote-agent
```

> Instalação a partir do código-fonte (para quem quer contribuir com o
> projeto) está descrita em [Setup do daemon](#setup-do-daemon) mais abaixo.

## Como funciona

```
┌─────────────────────────────────────────────┐
│                PC do trabalho                │
│                                               │
│  kiro-remote-agent (daemon)                  │
│    ├─ kiro-cli (PTY)                         │
│    ├─ Hub (WebSocket local, só p/ extensão)  │
│    └─ Bot do Discord ────────────────────────┼──▶ gateway.discord.gg
│         ▲                                    │    (conexão de saída)
│  Kiro IDE (extensão Bridge)                  │
│    conecta no Hub via ws://127.0.0.1          │
└───────────────────────────────────────────────┘

                                    Discord entrega push/mensagens
                                    para o seu celular automaticamente
```

1. O bot conecta no Discord fazendo uma requisição de **saída** (WebSocket
   Gateway) — igual o daemon já fazia antes com o relay, isso significa
   que **o PC do trabalho nunca precisa abrir porta nenhuma**.
2. Um canal do tipo **Fórum** no seu servidor Discord vira a lista de
   conversas: cada sessão do Kiro (a padrão do daemon, e cada sessão local
   do Kiro IDE) ganha sua própria thread. A primeira mensagem enviada numa
   thread pergunta ao agente; as respostas chegam na mesma thread.
3. Inicia (ou retoma) uma sessão `kiro-cli chat` **interativa** dentro de um
   pseudo-terminal (via `node-pty`) — não usa o modo `--no-interactive`,
   justamente porque esse modo não pausa para pedir aprovação de tools.
4. Toda mensagem que você manda numa thread do Discord chega
   **instantaneamente** (evento do gateway, não polling) e é digitada na
   sessão correspondente do `kiro-cli`.
5. Quando o `kiro-cli` pede aprovação para rodar uma tool
   (`APPROVAL_PROMPT_REGEX` detecta o prompt), o bot posta uma mensagem com
   três botões: **Aprovar / Sempre / Recusar**. Ao clicar, a mensagem é
   editada mostrando a decisão tomada.
6. Quando o `kiro-cli` fica "quieto" por um tempo
   (`IDLE_MS_BEFORE_TURN_COMPLETE`), o texto acumulado é postado como
   resposta do assistente na thread.
7. O histórico de cada conversa fica salvo **para sempre** na própria
   thread do Discord — não existe mais nenhum banco de dados ou backup a
   configurar.

O código, credenciais, MCPs e terminal continuam **100% no seu PC**. O
Discord só vê texto de mensagens e prompts de aprovação.

### Enviar imagens pelo Discord

Você pode anexar uma imagem numa mensagem do Discord (com ou sem legenda —
uma mensagem só com imagem também funciona) e o Kiro entende a imagem. Por
baixo dos panos:

1. O bot detecta anexos de imagem (por `content-type` ou extensão).
2. Cada imagem é **baixada para um arquivo temporário local** no seu PC
   (`$TMPDIR/kiro-remote-images/`), com nome aleatório (limite de 25 MB).
3. O caminho absoluto do arquivo é adicionado ao prompt, e o Kiro lê a
   imagem com suas próprias ferramentas de arquivo — funciona tanto na
   sessão padrão (`kiro-cli`) quanto nas sessões do Kiro IDE (via
   `sendPrompt`).

As URLs de anexo do Discord são temporárias, então o download acontece na
hora da entrega. Se um download falhar, o texto é enviado mesmo assim (você
não fica sem resposta). As imagens ficam no seu PC — o Discord é só o
transporte.

### Título das threads: `[projeto] título da sessão`

O nome de cada thread no Discord reflete o título que o **próprio Kiro** dá
à sessão, prefixado com o **nome do workspace/projeto** aberto — assim, de
relance, você sabe em qual projeto está mexendo. Exemplo:
`[meu-projeto] Corrigir bug no login`.

- O prefixo vem do nome da pasta do workspace da sessão (ou de
  `KIRO_PROJECT_DIR` para a sessão padrão).
- Sessão recém-criada nasce como `[projeto] Sessão a1b2c3d4` e é renomeada
  automaticamente assim que o Kiro gera o título de verdade (o daemon
  reconcilia os títulos a cada scan de `~/.kiro/sessions`).
- A API do Discord só é chamada quando o nome realmente muda — o Discord
  limita renomeação de canal de forma agressiva (~2 a cada 10 min), então
  um reconcile sem mudança não gera tráfego.

## Por que isso é melhor que polling num relay remoto

As duas versões anteriores deste projeto passaram por: (1) polling HTTPS
num Postgres remoto a cada poucos segundos, e depois (2) um hub WebSocket
próprio exposto via Cloudflare Tunnel. As duas funcionavam, mas exigiam
manter infraestrutura rodando (deploy no Vercel, banco de dados, túnel) só
para ter um "cliente remoto".

O Discord **já é** esse cliente remoto: push notification nativo, app
oficial pronto no celular, histórico persistente de graça, e conexão em
tempo real via gateway — exatamente o que a gente tentou reconstruir do
zero nas versões anteriores. Esta versão elimina:

- O relay Next.js/Vercel (não existe mais nenhum serviço web a manter).
- O Cloudflare Tunnel (o bot só faz conexões de saída).
- Qualquer banco de dados (o histórico vive nas threads do Discord).
- Login por senha, JWT, cookies de sessão (identidade já é o Discord).

## Pré-requisitos

- Node.js >= 20
- [`kiro-cli`](https://kiro.dev/docs/getting-started/installation) instalado
  e autenticado (`kiro-cli` deve funcionar manualmente no terminal antes de
  usar este daemon).
- Uma `KIRO_API_KEY` válida (requer plano Pro ou superior) para autenticação
  não-interativa — ver [docs de autenticação](https://kiro.dev/docs/getting-started/authentication).
- Uma conta Discord e um servidor (pode ser um servidor pessoal, só seu,
  criado em segundos).
- Ferramentas de build nativas (o `node-pty` compila um binário nativo):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential` + `python3`
  - Windows: `windows-build-tools` ou Visual Studio Build Tools

## Setup do Discord

### 1. Criar um servidor pessoal (se ainda não tiver um)

No app do Discord: **+** (barra lateral esquerda) → **Criar meu próprio** →
**Só para mim**. Dá um nome qualquer, ex. "Kiro Remote".

### 2. Criar um canal do tipo Fórum

No servidor: **+** ao lado de "Canais de texto" → **Canal** → escolha o
tipo **Fórum**. Nomeie como quiser, ex. `kiro-sessions`.

Habilite o **Modo Desenvolvedor** para conseguir copiar IDs: **Configurações
do usuário** (ícone de engrenagem) → **Avançado** → **Modo desenvolvedor**.

Depois, clique com o botão direito no canal fórum criado → **Copiar ID do
canal**. Esse valor vai em `DISCORD_FORUM_CHANNEL_ID`.

### 3. Criar a aplicação/bot no Developer Portal

1. Acesse https://discord.com/developers/applications → **New Application**.
2. Dê um nome (ex. "Kiro Remote") e crie.
3. Na aba **Bot** (menu lateral):
   - Clique **Reset Token** e copie o valor — vai em `DISCORD_BOT_TOKEN`.
     Trate isso como uma senha; nunca comite em nenhum arquivo.
   - Em **Privileged Gateway Intents**, habilite **Message Content
     Intent** (necessário para o bot ler o texto das suas mensagens nas
     threads).
4. Na aba **OAuth2** → **URL Generator**:
   - Em **Scopes**, marque `bot`.
   - Em **Bot Permissions**, marque: `View Channels`, `Send Messages`,
     `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`,
     `Read Message History`, `Embed Links`, `Attach Files`.
   - Copie a URL gerada no final da página e abra ela no navegador — vai
     pedir para você adicionar o bot ao seu servidor. Selecione o servidor
     que criou no passo 1.

Pronto — o bot já está no seu servidor, só falta ligar o daemon.

## Setup do daemon

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
[discord] logged in as SeuBot#1234
```

Se aparecer o login do Discord, está tudo certo — abra o app do Discord no
celular, vá até o canal fórum que você criou, e crie um novo post (ou entre
na thread "Chat padrão" que o bot cria automaticamente na primeira
mensagem) para começar a conversar.

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
| `HUB_PORT`                       | Porta local do servidor WebSocket do hub (padrão `8787`) — só a extensão do Kiro IDE conecta aqui |
| `HUB_SHARED_SECRET`              | Segredo usado pela extensão do Kiro IDE para autenticar no hub                 |
| `HOST_LABEL`                     | Nome amigável usado nos logs do daemon (ex: `work-macbook`)                    |
| `DISCORD_BOT_TOKEN`              | Token do bot, do Developer Portal (aba Bot → Reset Token)                     |
| `DISCORD_FORUM_CHANNEL_ID`       | ID do canal fórum onde as threads de sessão são criadas                       |
| `DISCORD_THREAD_MAP_PATH`        | Onde persistir o mapeamento sessão↔thread (padrão `./discord-threads.json`)   |
| `SESSION_SCAN_INTERVAL_MS`       | Intervalo (ms) do scan de `~/.kiro/sessions` — só usado para nomear threads novas |
| `KIRO_CLI_BIN`                    | Caminho do binário `kiro-cli`. Se for rodar via `pm2`/`launchd` (PATH restrito), use o caminho absoluto (ex: `/Users/voce/.local/bin/kiro-cli`) |
| `KIRO_PROJECT_DIR`                | Diretório do projeto onde o `kiro-cli` deve rodar                             |
| `KIRO_SESSION_ID`                 | (Opcional) ID de sessão específica a retomar; se vazio, usa a mais recente     |
| `KIRO_TRUST_TOOLS`                | Categorias de tool pré-aprovadas (ex: `read,grep`); vazio = tudo passa por aprovação manual pelo Discord |
| `KIRO_API_KEY`                    | Chave de API do Kiro para autenticação automatizada                           |
| `APPROVAL_PROMPT_REGEX`           | Regex para detectar prompts de aprovação — **calibrar** (ver aviso abaixo)      |
| `APPROVE_KEYSTROKES` / `DENY_KEYSTROKES` / `APPROVE_ALWAYS_KEYSTROKES` | Teclas enviadas ao PTY para cada decisão — **calibrar**      |
| `IDLE_MS_BEFORE_TURN_COMPLETE`    | Tempo de silêncio (ms) para considerar um turno concluído                     |
| `DEBUG_LOG_PATH`                  | Arquivo de log com saída crua do PTY (contém trechos da conversa — não commitar) |

## ⚠️ Aviso importante — calibração necessária

O formato exato dos prompts de aprovação do `kiro-cli` (o texto que ele
imprime pedindo "y/n" antes de rodar uma tool) **não é documentado
publicamente**. Os valores padrão de `APPROVAL_PROMPT_REGEX`,
`APPROVE_KEYSTROKES`, `DENY_KEYSTROKES` e `APPROVE_ALWAYS_KEYSTROKES` em
`.env.example` são heurísticos.

**Antes de confiar no fluxo de aprovação**, faça um teste controlado:

1. Rode o daemon com `DEBUG_LOG_PATH` apontando para um arquivo local.
2. Peça, pelo Discord, algo que dispare um prompt de aprovação (ex: pedir
   pro Kiro editar um arquivo).
3. Abra o `DEBUG_LOG_PATH` e veja exatamente o texto/teclas que o `kiro-cli`
   espera.
4. Ajuste `APPROVAL_PROMPT_REGEX` e as `*_KEYSTROKES` no `.env` conforme o
   que você observou.

Até calibrar isso, trate qualquer aprovação "silenciosa" (que não gerou
botões no Discord) com desconfiança — pode ser que a regex não tenha
detectado o prompt.

## Extensão Kiro Remote Bridge (Kiro IDE)

A extensão em `ide-extension/` conecta diretamente no hub local
(`ws://127.0.0.1:8787` por padrão — mesma máquina, sem internet nenhuma
envolvida). Configure em `settings.json` do Kiro IDE:

```json
{
  "kiroRemoteBridge.enabled": true,
  "kiroRemoteBridge.hubUrl": "ws://127.0.0.1:8787",
  "kiroRemoteBridge.hubSecret": "o-mesmo-valor-de-HUB_SHARED_SECRET"
}
```

### Instalando a extensão

A extensão é distribuída como um pacote `.vsix` — o mesmo formato de
qualquer extensão de VS Code/Kiro. Gere o pacote e instale:

```bash
cd ide-extension
yarn install
yarn package   # builda com esbuild e gera kiro-remote-bridge-0.1.0.vsix
```

Depois, instale o `.vsix` de uma das duas formas:

- **Pela CLI** (se `kiro` estiver no PATH):
  ```bash
  kiro --install-extension kiro-remote-bridge-0.1.0.vsix
  ```
- **Pela UI**: abra o Kiro IDE → painel de Extensions → menu `...` no topo →
  **Install from VSIX...** → selecione o arquivo gerado.

Em qualquer um dos dois casos, recarregue a janela depois
(`Cmd+Shift+P` → **Developer: Reload Window**).

O script `install-local.sh` (`./install-local.sh` dentro de `ide-extension/`)
faz os três passos acima de uma vez — útil durante o desenvolvimento da
própria extensão, mas o `.vsix` gerado é o mesmo artefato que qualquer
outro dev instalaria manualmente.

O `.vsix` é autocontido (o `ws` é embutido no bundle via esbuild) — não
depende de `node_modules` no destino, nem de nenhum passo manual em
`~/.kiro/extensions/`.

## Rodando em background

Recomenda-se manter o daemon rodando de forma persistente enquanto você
trabalha — como só há um processo agora (sem túnel separado para
gerenciar), isso ficou mais simples que antes:

```bash
# pm2
npm install -g pm2
pm2 start dist/index.js --name kiro-remote-agent

# ou simplesmente em um terminal dedicado com nohup
nohup yarn start > agent.out.log 2>&1 &
```

No macOS, um LaunchAgent também funciona bem para manter o processo vivo
entre reinicializações — veja `launchctl` / `~/Library/LaunchAgents`.

## Segurança

- O `DISCORD_BOT_TOKEN` dá controle completo do bot — trate como senha,
  nunca comite, nunca compartilhe uma captura de tela dele. Se suspeitar
  que vazou, gere um novo no Developer Portal (Bot → Reset Token).
- Qualquer pessoa com acesso ao seu servidor Discord e ao canal fórum
  consegue enviar mensagens para o agente. Se o servidor for só seu (o
  cenário recomendado), isso não é um risco — mas evite adicionar outras
  pessoas a esse servidor específico.
- O `HUB_SHARED_SECRET` protege o hub local (que só a extensão do Kiro IDE
  usa) — trate como senha também, mas o risco é bem menor já que o hub
  nunca é exposto para fora do seu PC.
- Por padrão (`KIRO_TRUST_TOOLS` vazio), **toda** chamada de tool passa por
  aprovação manual, igual no Kiro IDE. Só relaxe isso (adicionando
  categorias em `KIRO_TRUST_TOOLS`) se tiver certeza do que está liberando.
- `DEBUG_LOG_PATH` pode conter trechos da sua conversa/código em texto
  puro — já está no `.gitignore`, mas delete o arquivo depois de calibrar a
  regex de aprovação.
- `discord-threads.json` (ou o caminho que você configurar em
  `DISCORD_THREAD_MAP_PATH`) guarda apenas IDs de sessão e de thread — sem
  conteúdo de mensagens — mas ainda está no `.gitignore` por padrão.

## Limitações conhecidas

- Uma sessão do `kiro-cli` só pode estar ativa em um processo por vez. Se
  você abrir a mesma sessão no Kiro IDE enquanto este daemon estiver rodando
  com ela, um dos dois vai falhar ao conectar.
- A detecção de "fim de turno" é por heurística de silêncio no PTY, não por
  um sinal explícito do `kiro-cli` — turnos muito longos com pausas no meio
  podem ser fragmentados em múltiplas mensagens no Discord.
- O PC do trabalho precisa estar ligado, com o daemon rodando, para o
  Discord conseguir conversar com o agente — mas diferente de antes, o
  histórico de cada thread continua acessível no Discord mesmo com o PC
  desligado (só não recebe novas respostas até o daemon voltar).
- Mensagens muito longas (>2000 caracteres, limite do Discord) são
  quebradas automaticamente em várias mensagens.
- As respostas do Kiro para o Discord continuam sendo texto — imagens
  geradas/lidas pelo agente não são renderizadas de volta no Discord.
