/*! Open Historia — Discord edition: persistence (atomic JSON store). © 2026 Nicholas Krol, MIT. */
// A tiny durable store for the bot's per-guild game bookkeeping. Deliberately not
// SQLite: the data is small (one self-hosted guild, a handful of nations, the
// current round's ballots) and a native module needs a compiler the operator may
// not have. Durability comes from atomic writes (temp file + rename) plus a
// write-ahead ops log so a crash mid-resolve replays each engine op exactly once.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OH_DISCORD_DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TMP_FILE = path.join(DATA_DIR, "state.json.tmp");

const EMPTY = { guilds: {} };

const freshGame = (guildId) => ({
  guildId,
  active: false,
  round: 0,
  phase: "IDLE", // IDLE | COLLECTING | VOTING | RESOLVING | POSTING | INTERLUDE
  phaseEndsAt: 0,
  primaryNation: "",
  factionNations: [], // extra human nations (multi-nation games)
  channelId: "", // #world (shared read-only feed + ballots)
  players: {}, // userId -> nation
  ballots: {}, // ballotId -> { id, kind, decisionKey, options[], messageId, channelId, tallyClosed }
  votes: {}, // ballotId -> { userId -> optionId }
  pendingOps: [], // write-ahead: [{ opId, seq, method, args, applied }]
  liveUrl: "",
});

let state = null;

const ensureDir = () => mkdirSync(DATA_DIR, { recursive: true });

export const load = () => {
  if (state) return state;
  try {
    if (existsSync(STATE_FILE)) {
      state = JSON.parse(readFileSync(STATE_FILE, "utf8").replace(/^﻿/, ""));
      if (!state.guilds) state.guilds = {};
    } else {
      state = structuredClone(EMPTY);
    }
  } catch {
    // A corrupt store must not brick the bot — start fresh (a reconcile rebuilds
    // from the engine's own state on boot).
    state = structuredClone(EMPTY);
  }
  return state;
};

export const save = () => {
  ensureDir();
  const data = JSON.stringify(state, null, 2);
  writeFileSync(TMP_FILE, data);
  renameSync(TMP_FILE, STATE_FILE); // atomic on the same filesystem
};

export const getGame = (guildId) => {
  const s = load();
  if (!s.guilds[guildId]) {
    s.guilds[guildId] = freshGame(guildId);
    save();
  }
  return s.guilds[guildId];
};

export const updateGame = (guildId, mutate) => {
  const game = getGame(guildId);
  mutate(game);
  save();
  return game;
};

export const resetGame = (guildId) => {
  const s = load();
  s.guilds[guildId] = freshGame(guildId);
  save();
  return s.guilds[guildId];
};

// --- players ----------------------------------------------------------------
export const setPlayerNation = (guildId, userId, nation) =>
  updateGame(guildId, (g) => {
    if (nation) g.players[userId] = nation;
    else delete g.players[userId];
  });

// --- ballots + votes --------------------------------------------------------
export const addBallot = (guildId, ballot) =>
  updateGame(guildId, (g) => {
    g.ballots[ballot.id] = ballot;
    g.votes[ballot.id] = g.votes[ballot.id] || {};
  });

export const recordVote = (guildId, ballotId, userId, optionId) =>
  updateGame(guildId, (g) => {
    if (!g.votes[ballotId]) g.votes[ballotId] = {};
    if (optionId == null) delete g.votes[ballotId][userId];
    else g.votes[ballotId][userId] = optionId;
  });

export const clearBallots = (guildId) =>
  updateGame(guildId, (g) => {
    g.ballots = {};
    g.votes = {};
  });

// --- write-ahead ops log (idempotent reconcile) -----------------------------
// Each op has a deterministic opId (round + decisionKey + method) so a crash
// mid-flush replays only the ops not yet marked applied, exactly once.
export const enqueueOps = (guildId, ops) =>
  updateGame(guildId, (g) => {
    const seen = new Set(g.pendingOps.map((o) => o.opId));
    let seq = g.pendingOps.reduce((m, o) => Math.max(m, o.seq), 0);
    for (const op of ops) {
      if (seen.has(op.opId)) continue; // idempotent enqueue
      g.pendingOps.push({ ...op, seq: ++seq, applied: false });
    }
  });

export const pendingOps = (guildId) =>
  getGame(guildId).pendingOps.filter((o) => !o.applied).sort((a, b) => a.seq - b.seq);

export const markOpApplied = (guildId, opId) =>
  updateGame(guildId, (g) => {
    const op = g.pendingOps.find((o) => o.opId === opId);
    if (op) op.applied = true;
  });

export const clearOps = (guildId) =>
  updateGame(guildId, (g) => {
    g.pendingOps = [];
  });
