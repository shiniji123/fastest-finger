/**
 * Fast Finger server (updated)
 * - Node.js + Express + Socket.IO
 * - In-memory session store
 * - Auto-generate 4-digit room codes
 * - Room names (letters only: A–Z or ก–ฮ), <= 20 chars
 * - Player names (letters only: A–Z or ก–ฮ), <= 20 chars
 * - Rejoin with token (localStorage crypto.randomUUID)
 */
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---- In-memory store ----
/**
 * sessions: Map<sid, {
 *   sid: string,
 *   roomName: string,
 *   active: boolean,
 *   players: Set<string>,
 *   statuses: Map<string, 'idle'|'foul'|'buzzed'>,
 *   submissions: Array<{ name: string, ts: number }>,
 *   owners: Map<string, string>, // name -> token (for rejoin)
 *   createdAt: number
 * }>
 */
const sessions = new Map();

function validateSid(sid) { return typeof sid === "string" && /^\d{4}$/.test(sid); }
// English a-zA-Z or Thai ก-ฮ only, length 1–20
function validateHumanName(name) {
  return typeof name === "string" && /^([A-Za-z]|[\u0E01-\u0E2E]){1,20}$/.test(name.trim());
}
function sessionToJSON(sess) {
  return {
    sid: sess.sid,
    roomName: sess.roomName,
    active: sess.active,
    players: Array.from(sess.players),
    submissions: sess.submissions.slice().sort((a,b)=>a.ts-b.ts)
  };
}
function generateUniqueSid() {
  if (sessions.size >= 10000) return null; // exhausted
  let tries = 0;
  while (tries < 20000) {
    const sid = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    if (!sessions.has(sid)) return sid;
    tries++;
  }
  return null;
}

// ---- REST API ----

// Landing
app.get("/", (req,res)=> res.sendFile(path.join(__dirname, "public", "index.html")));

// Create session with roomName (server generates sid)
app.post("/api/session/create", (req,res)=>{
  const roomName = String(req.body.roomName || "").trim();
  if (!validateHumanName(roomName) || roomName.length === 0) {
    return res.status(400).json({ error: "Invalid room name (letters only A–Z or ก–ฮ, up to 20 chars)." });
  }
  const sid = generateUniqueSid();
  if (!sid) return res.status(503).json({ error: "Room capacity full. Try again later." });
  const sess = {
    sid, roomName,
    active: false,
    players: new Set(),
    statuses: new Map(),
    submissions: [],
    owners: new Map(),
    createdAt: Date.now(),
  };
  sessions.set(sid, sess);
  return res.status(201).json({ sid, roomName });
});

// Get session state
app.get("/api/session/:sid", (req,res)=>{
  const sid = req.params.sid;
  if (!validateSid(sid) || !sessions.has(sid)) return res.status(404).json({ error: "Session not found." });
  res.json(sessionToJSON(sessions.get(sid)));
});

// Join session (supports rejoin via token)
app.post("/api/session/:sid/join", (req,res)=>{
  const sid = req.params.sid;
  const name = (req.body.name || "").trim();
  const token = String(req.body.token || "").trim();
  if (!validateSid(sid) || !sessions.has(sid)) return res.status(404).json({ error: "Session not found." });
  if (!validateHumanName(name)) return res.status(400).json({ error: "Invalid name (letters only A–Z or ก–ฮ, up to 20 chars)." });
  if (!token) return res.status(400).json({ error: "Missing token." });

  const sess = sessions.get(sid);
  const owner = sess.owners.get(name);
  if (owner && owner !== token) {
    return res.status(409).json({ error: "This name is already used in this room." });
  }
  // Register or confirm ownership
  sess.owners.set(name, token);
  if (!sess.players.has(name)) {
    sess.players.add(name);
    sess.statuses.set(name, "idle");
  }

  io.to(sid).emit("player_joined", { sid, name, players: Array.from(sess.players) });
  res.json({ ok: true, sid, roomName: sess.roomName });
});

// CSV export
app.get("/api/session/:sid/submissions.csv", (req,res)=>{
  const sid = req.params.sid;
  if (!validateSid(sid) || !sessions.has(sid)) return res.status(404).send("Session not found");
  const sess = sessions.get(sid);
  const rows = [["Position","Name","TimestampISO","EpochMS"]];
  sess.submissions.slice().sort((a,b)=>a.ts-b.ts).forEach((s, idx)=>{
    rows.push([idx+1, s.name, new Date(s.ts).toISOString(), s.ts]);
  });
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="submissions_${sid}.csv"`);
  res.send(csv);
});

// ---- Socket.IO ----
io.on("connection", (socket)=>{
  socket.on("join_session", ({ sid, role, name })=>{
    if (!validateSid(sid) || !sessions.has(sid)) {
      socket.emit("error_message", "Session not found.");
      return;
    }
    socket.join(sid);
    socket.data.sid = sid;
    socket.data.role = role || "player";
    socket.data.name = name || null;
    const sess = sessions.get(sid);
    socket.emit("state", sessionToJSON(sess));
  });

  socket.on("start_game", ({ sid })=>{
    if (!validateSid(sid) || !sessions.has(sid)) return;
    const sess = sessions.get(sid);
    sess.active = true;
    io.to(sid).emit("game_state", { active: true });
  });

  socket.on("reset_game", ({ sid })=>{
    if (!validateSid(sid) || !sessions.has(sid)) return;
    const sess = sessions.get(sid);
    sess.active = false;
    sess.submissions = [];
    for (const name of sess.players) sess.statuses.set(name, "idle");
    io.to(sid).emit("reset");
    io.to(sid).emit("game_state", { active: false });
    io.to(sid).emit("state", sessionToJSON(sess));
  });

  socket.on("buzz", ({ sid, name })=>{
    if (!validateSid(sid) || !sessions.has(sid)) return;
    if (!validateHumanName(name)) return;
    const sess = sessions.get(sid);
    const state = sess.statuses.get(name) || "idle";

    if (!sess.active) {
      sess.statuses.set(name, "foul");
      socket.emit("you_fouled");
      return;
    }
    if (state === "foul" || state === "buzzed") return;

    const now = Date.now();
    sess.statuses.set(name, "buzzed");
    sess.submissions.push({ name, ts: now });
    io.to(sid).emit("new_submission", { name, ts: now });
  });

  socket.on("disconnect", ()=>{});
});

server.listen(PORT, ()=>{
  console.log(`Fast Finger server running on http://localhost:${PORT}`);
});
