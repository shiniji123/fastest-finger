
/**
 * Fastest Finger server
 * - Node.js + Express + Socket.IO
 * - In-memory session store
 */
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*"},
});

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---- In-memory store ----
/**
 * sessions: Map<sid, {
 *   active: boolean,
 *   players: Set<string>,
 *   statuses: Map<string, 'idle'|'foul'|'buzzed'>,
 *   submissions: Array<{ name: string, ts: number }>,
 *   createdAt: number
 * }>
 */
const sessions = new Map();

function validateSid(sid) {
  return typeof sid === "string" && /^\d{4}$/.test(sid);
}
function validateName(name) {
  return typeof name === "string" && /^[A-Za-z]{1,20}$/.test(name.trim());
}
function ensureSession(sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      active: false,
      players: new Set(),
      statuses: new Map(),
      submissions: [],
      createdAt: Date.now(),
    });
  }
  return sessions.get(sid);
}
function sessionToJSON(sess) {
  return {
    active: sess.active,
    players: Array.from(sess.players),
    submissions: sess.submissions
      .slice()
      .sort((a,b)=>a.ts-b.ts)
      .map((s, idx)=>({position: idx+1, name: s.name, ts: s.ts}))
  };
}

// ---- REST API ----

// Landing: send index.html
app.get("/", (req,res)=> {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Create session
app.post("/api/session", (req,res)=>{
  const sid = String(req.body.sid || "");
  if (!validateSid(sid)) {
    return res.status(400).json({ error: "Session ID must be exactly 4 digits (0000-9999)." });
  }
  if (sessions.has(sid)) {
    return res.status(409).json({ error: "Session ID already exists. Use a different 4-digit ID." });
  }
  ensureSession(sid);
  res.status(201).json({ sid });
});

// Get session state
app.get("/api/session/:sid", (req,res)=>{
  const sid = req.params.sid;
  if (!validateSid(sid) || !sessions.has(sid)) {
    return res.status(404).json({ error: "Session not found." });
  }
  return res.json({ sid, ...sessionToJSON(sessions.get(sid)) });
});

// Join session
app.post("/api/session/:sid/join", (req,res)=>{
  const sid = req.params.sid;
  const name = (req.body.name || "").trim();
  if (!validateSid(sid) || !sessions.has(sid)) {
    return res.status(404).json({ error: "Session not found." });
  }
  if (!validateName(name)) {
    return res.status(400).json({ error: "Name must be English letters only (A-Z/a-z) and up to 20 characters." });
  }
  const sess = ensureSession(sid);
  if (sess.players.has(name)) {
    return res.status(409).json({ error: "This name is already taken in this session." });
  }
  sess.players.add(name);
  sess.statuses.set(name, "idle");

  io.to(sid).emit("player_joined", { sid, name, players: Array.from(sess.players) });
  res.json({ ok: true });
});

// CSV export
app.get("/api/session/:sid/submissions.csv", (req,res)=>{
  const sid = req.params.sid;
  if (!validateSid(sid) || !sessions.has(sid)) {
    return res.status(404).send("Session not found");
  }
  const sess = sessions.get(sid);
  const rows = [["Position","Name","TimestampISO","EpochMS"]];
  sess.submissions
    .slice()
    .sort((a,b)=>a.ts-b.ts)
    .forEach((s, idx)=>{
      rows.push([idx+1, s.name, new Date(s.ts).toISOString(), s.ts]);
    });
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="submissions_${sid}.csv"`);
  res.send(csv);
});

// ---- Socket.IO ----
io.on("connection", (socket)=>{
  // join room for live updates
  socket.on("join_session", ({ sid, role, name })=>{
    if (!validateSid(sid) || !sessions.has(sid)) {
      socket.emit("error_message", "Session not found.");
      return;
    }
    socket.join(sid);
    socket.data.sid = sid;
    socket.data.role = role || "player";
    socket.data.name = name || null;

    // Send current state
    const sess = sessions.get(sid);
    socket.emit("state", { sid, ...sessionToJSON(sess) });
  });

  // Moderator actions
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
    // Reset all player statuses
    for (const name of sess.players) {
      sess.statuses.set(name, "idle");
    }
    io.to(sid).emit("reset");
    io.to(sid).emit("game_state", { active: false });
    io.to(sid).emit("state", { sid, ...sessionToJSON(sess) });
  });

  // Player action: buzz press
  socket.on("buzz", ({ sid, name })=>{
    if (!validateSid(sid) || !sessions.has(sid)) return;
    if (!validateName(name)) return;
    const sess = sessions.get(sid);
    const state = sess.statuses.get(name) || "idle";

    // If pressed while game is inactive -> FOUL and lock until reset
    if (!sess.active) {
      sess.statuses.set(name, "foul");
      socket.emit("you_fouled");
      return;
    }

    // If already fouled or already buzzed, ignore
    if (state === "foul" || state === "buzzed") return;

    const now = Date.now();
    sess.statuses.set(name, "buzzed");
    sess.submissions.push({ name, ts: now });

    // Broadcast to everyone in the session
    io.to(sid).emit("new_submission", { name, ts: now });
  });

  // optional: handle disconnects (we keep players listed)
  socket.on("disconnect", ()=>{});
});

server.listen(PORT, ()=> {
  console.log(`Fastest Finger server running on http://localhost:${PORT}`);
});
