"use strict";

const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const ALL_CIVILIZATIONS = require("./public/civs.js");

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
const ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_COUNT = 6;
// Game settings drafted alongside civs: each player decides two of them, assigned at random on every (re)roll.
const MAP_OPTIONS = {
  cityStates: ["yes", "no"],
  barbarians: ["yes", "no"],
  ruins: ["yes", "no"],
  congress: ["yes", "no"],
};
const MAP_OPTION_KEYS = Object.keys(MAP_OPTIONS);

const app = express();
// Icons are cached; HTML/JS are revalidated every load (cheap 304s) so updates reach players immediately.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    res.setHeader("Cache-Control", file.endsWith(".png") ? "public, max-age=86400" : "no-cache");
  },
}));
app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });

// ---------- game logic (ported from the original single-file client) ----------

function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function newState() {
  return {
    banned: new Set(),
    count: DEFAULT_COUNT,
    hasRolled: false,
    rev: 0, // bumped on every (re)roll so clients can animate
    pools: { 1: [], 2: [] },
    picks: { 1: null, 2: null },
    crossed: { 1: new Set(), 2: new Set() },
    mapOptions: {}, // key -> { owner: 1|2, value: string|null }
  };
}

function availableCivs(st) {
  return ALL_CIVILIZATIONS.filter(name => !st.banned.has(name));
}

function maxPerPlayer(st) {
  return Math.max(1, Math.floor(availableCivs(st).length / 2));
}

function clampCount(st, n) {
  n = parseInt(n, 10);
  const max = maxPerPlayer(st);
  if (!Number.isFinite(n)) n = Math.min(DEFAULT_COUNT, max);
  return Math.max(1, Math.min(max, n));
}

function generatePools(st) {
  st.count = clampCount(st, st.count);
  const draw = shuffled(availableCivs(st));
  st.pools[1] = draw.slice(0, st.count);
  st.pools[2] = draw.slice(st.count, st.count * 2);
  st.picks[1] = null;
  st.picks[2] = null;
  st.crossed[1].clear();
  st.crossed[2].clear();
  const keys = shuffled(MAP_OPTION_KEYS);
  st.mapOptions = {};
  keys.forEach((key, i) => { st.mapOptions[key] = { owner: i < keys.length / 2 ? 1 : 2, value: null }; });
  st.rev++;
}

const isRevealed = st => !!(st.picks[1] && st.picks[2]);
const optionsDone = st => MAP_OPTION_KEYS.every(k => st.mapOptions[k] && st.mapOptions[k].value !== null);
// Settings are final once anyone has picked a civ, so nobody can adjust them after seeing the other side commit.
const optionsLocked = st => !!(st.picks[1] || st.picks[2]);

// ---------- sessions ----------

const sessions = new Map();

function getOrCreateSession(id) {
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) return null;
    s = { id, seats: { 1: null, 2: null }, clients: new Set(), state: newState(), touched: Date.now() };
    sessions.set(id, s);
  }
  return s;
}

function seatOnline(session, seat) {
  for (const c of session.clients) if (c.seat === seat) return true;
  return false;
}

// The opponent's option choices are withheld (only "has chosen" is shown) until all options are set.
function optionsView(st, seat) {
  const done = optionsDone(st);
  const view = {};
  for (const [key, opt] of Object.entries(st.mapOptions)) {
    const visible = done || opt.owner === seat;
    view[key] = { owner: opt.owner, value: visible ? opt.value : null, chosen: opt.value !== null };
  }
  return view;
}

// What a given seat is allowed to see. The opponent's pick is withheld until both have picked.
function viewFor(session, seat) {
  const st = session.state;
  const revealed = isRevealed(st);
  const picks = { 1: null, 2: null };
  if (revealed) {
    picks[1] = st.picks[1];
    picks[2] = st.picks[2];
  } else if (seat === 1 || seat === 2) {
    picks[seat] = st.picks[seat];
  }
  return {
    type: "state",
    you: seat,
    online: { 1: seatOnline(session, 1), 2: seatOnline(session, 2) },
    seatTaken: { 1: !!session.seats[1], 2: !!session.seats[2] },
    banned: [...st.banned],
    count: st.count,
    maxCount: maxPerPlayer(st),
    hasRolled: st.hasRolled,
    rev: st.rev,
    pools: st.pools,
    crossed: { 1: [...st.crossed[1]], 2: [...st.crossed[2]] },
    picked: { 1: !!st.picks[1], 2: !!st.picks[2] },
    revealed,
    picks,
    mapOptions: optionsView(st, seat),
    optionsDone: optionsDone(st),
    optionsLocked: optionsLocked(st),
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(session) {
  session.touched = Date.now();
  for (const c of session.clients) send(c, viewFor(session, c.seat));
}

function handleJoin(ws, msg) {
  if (ws.session) return;
  if (typeof msg.id !== "string" || !ID_RE.test(msg.id)) return send(ws, { type: "error", message: "Invalid session id." });
  if (typeof msg.token !== "string" || !TOKEN_RE.test(msg.token)) return send(ws, { type: "error", message: "Invalid token." });

  const session = getOrCreateSession(msg.id);
  if (!session) return send(ws, { type: "error", message: "Server is full, try again later." });

  let seat = 0;
  if (session.seats[1] === msg.token) seat = 1;
  else if (session.seats[2] === msg.token) seat = 2;
  else if (!session.seats[1]) { session.seats[1] = msg.token; seat = 1; }
  else if (!session.seats[2]) { session.seats[2] = msg.token; seat = 2; }

  ws.session = session;
  ws.seat = seat;
  session.clients.add(ws);
  broadcast(session);
}

function handleAction(ws, msg) {
  const session = ws.session;
  const seat = ws.seat;
  if (!session) return;
  if (seat !== 1 && seat !== 2) return send(ws, { type: "error", message: "Spectators cannot change the draft." });

  const st = session.state;
  const civ = typeof msg.civ === "string" ? msg.civ : "";

  switch (msg.type) {
    case "toggleBan":
      if (!ALL_CIVILIZATIONS.includes(civ)) return;
      if (st.banned.has(civ)) st.banned.delete(civ);
      else st.banned.add(civ);
      st.count = clampCount(st, st.count);
      break;

    case "setCount":
      st.count = clampCount(st, msg.n);
      if (st.hasRolled) generatePools(st);
      break;

    case "roll":
      if (availableCivs(st).length < 2) {
        return send(ws, { type: "error", message: "Ban fewer civilizations — at least 2 must remain to roll." });
      }
      st.hasRolled = true;
      generatePools(st);
      break;

    case "setOption": {
      const key = typeof msg.key === "string" ? msg.key : "";
      const opt = Object.hasOwn(MAP_OPTIONS, key) ? st.mapOptions[key] : null;
      if (!st.hasRolled || !opt || opt.owner !== seat || optionsLocked(st)) return;
      if (!MAP_OPTIONS[key].includes(msg.value)) return;
      opt.value = msg.value;
      break;
    }

    case "pick":
      if (!st.hasRolled || isRevealed(st)) return; // picks are final once both are in
      if (!optionsDone(st)) return send(ws, { type: "error", message: "Set all game options before picking a civilization." });
      if (!st.pools[seat].includes(civ) || st.crossed[seat].has(civ)) return;
      st.picks[seat] = st.picks[seat] === civ ? null : civ;
      break;

    case "toggleCross": {
      // Either player may cross out civs in either pool; the marks are shared.
      const owner = msg.player === 1 || msg.player === 2 ? msg.player : seat;
      if (!st.hasRolled || isRevealed(st)) return;
      if (!st.pools[owner].includes(civ)) return;
      if (st.crossed[owner].has(civ)) {
        st.crossed[owner].delete(civ);
      } else {
        st.crossed[owner].add(civ);
        // Only the owner crossing their own pick clears it; clearing someone else's
        // pick would change their "has picked" flag and leak information.
        if (owner === seat && st.picks[owner] === civ) st.picks[owner] = null;
      }
      break;
    }

    default:
      return;
  }
  broadcast(session);
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.session = null;
  ws.seat = 0;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "join") handleJoin(ws, msg);
    else handleAction(ws, msg);
  });

  ws.on("close", () => {
    const session = ws.session;
    if (!session) return;
    session.clients.delete(ws);
    broadcast(session);
  });

  ws.on("error", () => {});
});

// Keep connections alive through proxies and drop dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

// Forget sessions nobody has touched for a day.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.clients.size === 0 && now - s.touched > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Civ draft server on http://localhost:${PORT}`));
