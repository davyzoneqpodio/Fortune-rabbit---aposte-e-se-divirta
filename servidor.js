const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = Number(process.env.PORT) || 3000;

// Os dados desta versão ficam em memória.
// Em um serviço gratuito eles podem ser perdidos após reinício/suspensão.
const rooms = new Map();
const globalRanking = new Map();
const roomSockets = new Map();

const MAX_PLAYERS_PER_ROOM = 7;
const ROOM_CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 18;
const MAX_GAIN = 1_000_000_000;
const ROOM_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;

function makeRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .substring(2, 2 + ROOM_CODE_LENGTH)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function makePlayerId() {
  return crypto.randomUUID();
}

function cleanName(name) {
  const value = String(name || "").trim();
  return (value || "Jogador").slice(0, MAX_NAME_LENGTH);
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

function getRequestPlayerId(req, body = {}) {
  return String(req.get("x-player-id") || body.playerId || "").trim();
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function touchRoom(room, player) {
  const now = Date.now();
  room.lastActivityAt = now;
  if (player) player.lastSeenAt = now;
}

function serializeRoom(room, playerId = "") {
  const now = Date.now();
  return {
    code: room.code,
    started: room.started,
    youAreHost: room.hostId === playerId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      gain: Number(player.gain) || 0,
      profit: Number(player.profit) || 0,
      balance: Number(player.balance) || 0,
      spins: Number(player.spins) || 0,
      wagered: Number(player.wagered) || 0,
      prizes: Number(player.prizes) || 0,
      active: Boolean(player.lastSeenAt && now - player.lastSeenAt < 25_000),
      host: player.id === room.hostId
    }))
  };
}

function roomPayload(room, playerId = "") {
  return {
    type: "room:update",
    ...serializeRoom(room, playerId)
  };
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function broadcastRoom(room, type = "room:update") {
  const sockets = roomSockets.get(room.code);
  if (!sockets) return;

  for (const ws of sockets) {
    const playerId = ws.playerId || "";
    sendJson(ws, {
      type,
      ...serializeRoom(room, playerId)
    });
  }
}

function registerSocket(ws, roomCode) {
  if (!roomSockets.has(roomCode)) {
    roomSockets.set(roomCode, new Set());
  }
  roomSockets.get(roomCode).add(ws);
}

function unregisterSocket(ws) {
  if (!ws.roomCode) return;

  const sockets = roomSockets.get(ws.roomCode);
  if (!sockets) return;

  sockets.delete(ws);
  if (sockets.size === 0) {
    roomSockets.delete(ws.roomCode);
  }
}

function addGlobalGain(name, gain) {
  const clean = cleanName(name);
  const amount = Number(gain);

  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_GAIN) {
    return null;
  }

  const key = clean.toLowerCase();
  const previous = globalRanking.get(key);

  const entry = {
    name: previous?.name || clean,
    gain: Number(previous?.gain || 0) + amount
  };

  globalRanking.set(key, entry);
  return entry;
}

function getGlobalRanking() {
  return [...globalRanking.values()]
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 20);
}

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check simples para testar o serviço no Render.
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "fortune-rabbit",
    rooms: rooms.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// =========================
// SALAS
// =========================

app.post("/api/rooms", (req, res) => {
  const name = cleanName(req.body?.name);
  const code = makeRoomCode();
  const playerId = makePlayerId();
  const now = Date.now();

  const room = {
    code,
    hostId: playerId,
    started: false,
    createdAt: now,
    lastActivityAt: now,
    players: [
      {
        id: playerId,
        name,
        gain: 0,
        profit: 0,
        balance: 1000,
        spins: 0,
        wagered: 0,
        prizes: 0,
        lastSeenAt: now
      }
    ]
  };

  rooms.set(code, room);

  res.json({
    ok: true,
    code,
    playerId,
    youAreHost: true,
    players: serializeRoom(room, playerId).players
  });
});

app.get("/api/rooms/:code", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Sala não encontrada."
    });
  }

  const playerId = getRequestPlayerId(req);
  const player = findPlayer(room, playerId);

  if (player) touchRoom(room, player);
  else room.lastActivityAt = Date.now();

  res.json({
    ok: true,
    ...serializeRoom(room, playerId)
  });
});

app.post("/api/rooms/:code/join", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Sala não encontrada."
    });
  }

  if (room.started) {
    return res.status(409).json({
      ok: false,
      error: "Essa sala já começou."
    });
  }

  if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
    return res.status(409).json({
      ok: false,
      error: `A sala já está cheia (máximo de ${MAX_PLAYERS_PER_ROOM} jogadores).`
    });
  }

  const name = cleanName(req.body?.name);
  const playerId = makePlayerId();
  const now = Date.now();

  room.players.push({
    id: playerId,
    name,
    gain: 0,
    profit: 0,
    balance: 1000,
    spins: 0,
    wagered: 0,
    prizes: 0,
    lastSeenAt: now
  });

  touchRoom(room, room.players[room.players.length - 1]);

  res.json({
    ok: true,
    code: room.code,
    playerId,
    youAreHost: false,
    players: serializeRoom(room, playerId).players
  });

  broadcastRoom(room);
});

app.post("/api/rooms/:code/start", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Sala não encontrada."
    });
  }

  const playerId = getRequestPlayerId(req);
  const player = findPlayer(room, playerId);

  if (!player || room.hostId !== playerId) {
    return res.status(403).json({
      ok: false,
      error: "Somente o anfitrião pode começar a sala."
    });
  }

  if (room.started) {
    return res.json({
      ok: true,
      ...serializeRoom(room, playerId)
    });
  }

  room.started = true;
  touchRoom(room, player);

  const payload = serializeRoom(room, playerId);
  res.json({ ok: true, ...payload });
  broadcastRoom(room, "room:started");
});

app.post("/api/rooms/:code/leave", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Sala não encontrada."
    });
  }

  const playerId = getRequestPlayerId(req);
  const index = room.players.findIndex((player) => player.id === playerId);

  if (index === -1) {
    return res.json({
      ok: true,
      message: "Jogador não estava na sala."
    });
  }

  const wasHost = room.hostId === playerId;
  room.players.splice(index, 1);
  room.lastActivityAt = Date.now();

  if (room.players.length === 0) {
    rooms.delete(room.code);

    const sockets = roomSockets.get(room.code);
    if (sockets) {
      for (const ws of sockets) {
        sendJson(ws, { type: "room:closed" });
        ws.close(1000, "Sala encerrada");
      }
      roomSockets.delete(room.code);
    }

    return res.json({
      ok: true,
      deleted: true,
      players: []
    });
  }

  if (wasHost) {
    room.hostId = room.players[0].id;
  }

  const payload = serializeRoom(room, playerId);
  res.json({ ok: true, ...payload });
  broadcastRoom(room);
});

app.post("/api/rooms/:code/gain", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Sala não encontrada."
    });
  }

  const playerId = getRequestPlayerId(req, req.body);
  const player = findPlayer(room, playerId);

  if (!player) {
    return res.status(403).json({
      ok: false,
      error: "Jogador não pertence a essa sala."
    });
  }

  const gain = Number(req.body?.gain);

  if (!Number.isFinite(gain) || gain <= 0 || gain > MAX_GAIN) {
    return res.status(400).json({
      ok: false,
      error: "Valor de ganho inválido."
    });
  }

  player.gain += gain;
  touchRoom(room, player);

  const payload = {
    ok: true,
    players: serializeRoom(room, playerId).players
  };

  res.json(payload);
  broadcastRoom(room);
});

app.post("/api/rooms/:code/score", (req, res) => {
  const room = getRoom(req.params.code);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Sala não encontrada." });
  }

  const playerId = getRequestPlayerId(req, req.body);
  const player = findPlayer(room, playerId);

  if (!player) {
    return res.status(403).json({ ok: false, error: "Jogador não pertence a essa sala." });
  }

  const balance = Number(req.body?.balance);
  const spins = Number(req.body?.spins);
  const wagered = Number(req.body?.wagered);
  const prizes = Number(req.body?.prizes);

  if (
    !Number.isFinite(balance) || balance < 0 || balance > 1_000_000_000 ||
    !Number.isFinite(spins) || spins < 0 || spins > 1_000_000 ||
    !Number.isFinite(wagered) || wagered < 0 || wagered > MAX_GAIN ||
    !Number.isFinite(prizes) || prizes < 0 || prizes > MAX_GAIN
  ) {
    return res.status(400).json({ ok: false, error: "Placar inválido." });
  }

  player.balance = balance;
  player.spins = Math.floor(spins);
  player.wagered = wagered;
  player.prizes = prizes;
  player.profit = balance - 1000;
  touchRoom(room, player);

  const payload = { ok: true, players: serializeRoom(room, playerId).players };
  res.json(payload);
  broadcastRoom(room);
});

// =========================
// RANKING GLOBAL
// =========================

app.get("/api/ranking", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(getGlobalRanking());
});

app.post("/api/cashout", (req, res) => {
  const name = cleanName(req.body?.name);
  const gain = Number(req.body?.gain);

  if (!Number.isFinite(gain) || gain <= 0 || gain > MAX_GAIN) {
    return res.status(400).json({
      ok: false,
      error: "Valor de ganho inválido."
    });
  }

  const entry = addGlobalGain(name, gain);

  res.json({
    ok: true,
    entry,
    ranking: getGlobalRanking()
  });
});

// 404 em JSON para rotas de API.
app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota de API não encontrada."
  });
});

// =========================
// WEBSOCKET — SALAS EM TEMPO REAL
// =========================

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    const playerId = String(url.searchParams.get("playerId") || "").trim();
    const room = getRoom(code);

    if (!room || !playerId || !findPlayer(room, playerId)) {
      sendJson(ws, {
        type: "room:error",
        error: "Conexão de sala inválida."
      });
      ws.close(1008, "Sala ou jogador inválido");
      return;
    }

    ws.roomCode = room.code;
    ws.playerId = playerId;
    ws.isAlive = true;

    const player = findPlayer(room, playerId);
    touchRoom(room, player);
    registerSocket(ws, room.code);

    sendJson(ws, {
      type: "room:connected",
      ...serializeRoom(room, playerId)
    });

    broadcastRoom(room);

    ws.on("pong", () => {
      ws.isAlive = true;
      const currentRoom = getRoom(ws.roomCode);
      if (!currentRoom) return;
      const currentPlayer = findPlayer(currentRoom, ws.playerId);
      if (currentPlayer) touchRoom(currentRoom, currentPlayer);
    });

    ws.on("message", (raw) => {
      // Neste estágio o cliente não precisa enviar comandos de jogo pelo WebSocket.
      // O canal é usado para receber atualizações imediatamente e manter o lobby sincronizado.
      const currentRoom = getRoom(ws.roomCode);
      if (!currentRoom) return;

      const currentPlayer = findPlayer(currentRoom, ws.playerId);
      if (currentPlayer) touchRoom(currentRoom, currentPlayer);

      try {
        const message = JSON.parse(raw.toString());
        if (message?.type === "ping") {
          sendJson(ws, { type: "pong", now: Date.now() });
        }
      } catch {
        // Ignora mensagens que não sejam JSON válido.
      }
    });

    ws.on("close", () => {
      unregisterSocket(ws);
    });

    ws.on("error", () => {
      unregisterSocket(ws);
    });
  } catch {
    ws.close(1011, "Erro interno");
  }
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

heartbeat.unref?.();

// Limpeza automática de salas sem atividade.
const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    const lastActivity = room.lastActivityAt || room.createdAt || now;

    if (now - lastActivity <= ROOM_IDLE_LIMIT_MS) continue;

    const sockets = roomSockets.get(code);
    if (sockets) {
      for (const ws of sockets) {
        sendJson(ws, { type: "room:closed", reason: "Sala expirada" });
        ws.close(1000, "Sala expirada");
      }
    }

    roomSockets.delete(code);
    rooms.delete(code);
  }
}, 10 * 60 * 1000);

cleanupTimer.unref?.();

server.listen(PORT, () => {
  console.log(`Fortune Rabbit rodando na porta ${PORT}`);
});
