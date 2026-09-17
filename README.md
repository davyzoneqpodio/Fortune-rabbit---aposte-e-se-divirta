# Fortune Rabbit

Versão 1.2 do Fortune Rabbit: jogo individual com créditos fictícios, ranking global e salas competitivas para até 7 amigos.

## Estrutura

- `index.html` — interface, máquina de caça-níquel fictícia, ranking e lobby das salas
- `servidor.js` — servidor Express, salas, ranking e WebSocket
- `package.json` — dependências e comando de inicialização
- `.gitignore` — arquivos locais que não devem ir para o Git

## Modos

### Offline
Jogo local com créditos fictícios.

### Online
Cada jogador possui sua própria sessão e pode registrar ganhos no ranking global do servidor.

### Sala
Uma pessoa cria a sala e recebe um código de 6 caracteres. Até 7 jogadores podem entrar. O anfitrião inicia a partida.

Cada jogador tem uma máquina independente. Os giros não são compartilhados. O que é compartilhado é o placar: lucro atual, saldo, número de rodadas e atividade. O placar é atualizado por WebSocket, com polling de 5 segundos como fallback.

## Rotas HTTP

- `POST /api/rooms` — criar sala
- `POST /api/rooms/:code/join` — entrar
- `GET /api/rooms/:code` — consultar sala
- `POST /api/rooms/:code/start` — iniciar, somente anfitrião
- `POST /api/rooms/:code/leave` — sair
- `POST /api/rooms/:code/gain` — registrar ganho acumulado ao finalizar a sessão
- `POST /api/rooms/:code/score` — atualizar o desempenho atual da sessão no placar
- `GET /api/ranking` — ranking global
- `POST /api/cashout` — registrar ganho global
- `GET /health` — health check

## WebSocket

Endpoint:

```text
/ws?code=CODIGO&playerId=ID
```

Eventos enviados pelo servidor:

- `room:connected`
- `room:update`
- `room:started`
- `room:closed`
- `room:error`

## Deploy no Render

Build command:

```text
npm install
```

Start command:

```text
npm start
```

O servidor usa `process.env.PORT`, então funciona com a porta atribuída pelo Render.

## Limitações atuais

Os jogadores e o ranking ficam em memória. Um reinício, suspensão ou novo deploy pode limpar esses dados. Para persistência real seria necessário um banco de dados externo.

A lógica de giro da máquina ainda é executada no navegador. O servidor recebe o placar informado pelo cliente; portanto, esta competição é adequada para uma brincadeira entre amigos, mas não deve ser tratada como um sistema antifraude. Os dados continuam em memória e podem ser perdidos após reinício/suspensão.

Todos os créditos e saques são fictícios; este projeto não processa dinheiro real.
