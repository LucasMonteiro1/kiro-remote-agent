# kiro-remote-agent

Daemon local que roda no seu PC (do trabalho, por exemplo) e faz a ponte
entre uma sessão interativa do `kiro-cli` e o
[kiro-remote-relay](https://github.com/LucasMonteiro1/kiro-remote-relay), para
você continuar a conversa pelo celular.

## Como funciona

Este daemon:

1. Inicia (ou retoma) uma sessão `kiro-cli chat` **interativa** dentro de um
   pseudo-terminal (via `node-pty`) — não usa o modo `--no-interactive`,
   justamente porque esse modo não pausa para pedir aprovação de tools.
2. Faz polling no relay a cada poucos segundos buscando mensagens novas
   enviadas do celular, e as digita na sessão do `kiro-cli`.
3. Observa a saída do `kiro-cli` no PTY: quando o texto bate com um padrão de
   prompt de aprovação (`APPROVAL_PROMPT_REGEX`), publica um
   `approval_request` no relay — isso aparece no celular como um card com
   botões **Aprovar / Sempre / Recusar**.
4. Quando você responde no celular, o daemon recebe a decisão no próximo
   poll e envia as teclas correspondentes (`y`, `n`, etc.) de volta para o
   PTY, como se você tivesse digitado no terminal.
5. Quando o `kiro-cli` fica "quieto" por um tempo (`IDLE_MS_BEFORE_TURN_COMPLETE`),
   considera o turno concluído e envia o texto acumulado como resposta do
   assistente para o relay.

O código, credenciais, MCPs e terminal continuam **100% no seu PC**. O relay
e o celular só vêem texto de mensagens e prompts.

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
  já rodando.
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
| `KIRO_CLI_BIN`                    | Caminho do binário `kiro-cli`. Se for rodar via `pm2`/`launchd` (PATH restrito), use o caminho absoluto (ex: `/Users/voce/.local/bin/kiro-cli`) |
| `RELAY_URL`                      | URL do seu kiro-remote-relay deployado (ex: `https://kiro-remote.vercel.app`)  |
| `AGENT_SHARED_SECRET`            | Deve ser **idêntico** ao configurado no relay                                 |
| `HOST_LABEL`                     | Nome amigável exibido no celular (ex: `work-macbook`)                         |
| `KIRO_PROJECT_DIR`                | Diretório do projeto onde o `kiro-cli` deve rodar                             |
| `KIRO_SESSION_ID`                 | (Opcional) ID de sessão específica a retomar; se vazio, usa a mais recente     |
| `KIRO_TRUST_TOOLS`                | Categorias de tool pré-aprovadas (ex: `read,grep`); vazio = tudo passa por aprovação manual pelo celular |
| `KIRO_API_KEY`                    | Chave de API do Kiro para autenticação automatizada                           |
| `APPROVAL_PROMPT_REGEX`           | Regex para detectar prompts de aprovação — **calibrar** (ver aviso acima)      |
| `APPROVE_KEYSTROKES` / `DENY_KEYSTROKES` / `APPROVE_ALWAYS_KEYSTROKES` | Teclas enviadas ao PTY para cada decisão — **calibrar**      |
| `IDLE_MS_BEFORE_TURN_COMPLETE`    | Tempo de silêncio (ms) para considerar um turno concluído                     |
| `DEBUG_LOG_PATH`                  | Arquivo de log com saída crua do PTY (contém trechos da conversa — não commitar) |

## Rodando em background

Recomenda-se manter isso rodando de forma persistente enquanto você
trabalha. Algumas opções:

```bash
# pm2
npm install -g pm2
pm2 start dist/index.js --name kiro-remote-agent

# ou simplesmente em um terminal dedicado com nohup
nohup yarn start > agent.out.log 2>&1 &
```

## Segurança

- Este daemon só faz requisições **de saída** (polling) para o relay — não
  abre nenhuma porta local nem precisa de configuração de firewall/rede.
- O `AGENT_SHARED_SECRET` dá controle completo sobre o que este daemon pode
  fazer no seu PC (digitar mensagens na sua sessão do Kiro). Trate-o como
  uma senha — nunca commite o `.env`, nunca coloque em capturas de tela.
- Por padrão (`KIRO_TRUST_TOOLS` vazio), **toda** chamada de tool passa por
  aprovação manual, igual no Kiro IDE. Só relaxe isso (adicionando
  categorias em `KIRO_TRUST_TOOLS`) se tiver certeza do que está liberando.
- `DEBUG_LOG_PATH` pode conter trechos da sua conversa/código em texto
  puro — já está no `.gitignore`, mas delete o arquivo depois de calibrar a
  regex de aprovação.

## Limitações conhecidas

- Uma sessão do `kiro-cli` só pode estar ativa em um processo por vez. Se
  você abrir a mesma sessão no Kiro IDE enquanto este daemon estiver rodando
  com ela, um dos dois vai falhar ao conectar.
- A detecção de "fim de turno" é por heurística de silêncio no PTY, não por
  um sinal explícito do `kiro-cli` — turnos muito longos com pausas no meio
  podem ser fragmentados em múltiplas mensagens no celular.
- Sem suporte a anexos/imagens — apenas texto.
