/*! Open Historia — Discord edition: supervisor. © 2026 Nicholas Krol, MIT. */
// Spawns and self-heals the five processes that make up the Discord edition and
// wires them together, mirroring open-historia-node/app/run.mjs:
//   1. game server   (the submoduled fork's server/server.js)  HOST=127.0.0.1  (loopback only)
//   2. spectator proxy   GET/HEAD/OPTIONS -> game, 403 everything else
//   3. bot bridge        headless Playwright Chromium -> game/?bot=1, loopback RPC
//   4. discord bot       discord.js -> voting -> bridge RPC -> posts map + events
//   5. cloudflared       --url the SPECTATOR proxy (never the game port)
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const cfgPath = path.join(REPO_ROOT, "discord.config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, "")) : {};

const GAME_PORT = Number(cfg.gamePort || 3000);
const SPECTATOR_PORT = Number(cfg.spectatorPort || 8080);
const BRIDGE_PORT = Number(cfg.bridgePort || 8090);
// The built game: a checkout with server/server.js + dist/. Default to the
// submodule at ../game (the bot repo pins the fork's discord-edition branch there).
const GAME_DIR = cfg.gameDir || path.join(REPO_ROOT, "game");
const GAME_ENTRY = path.join(GAME_DIR, "server", "server.js");

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_URL_FILE = path.join(DATA_DIR, "public-url.txt");
const cfBin = path.join(__dirname, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

let stopping = false;
let tunnel = null;
let stoppingTunnel = false;
// Every live child, so shutdown takes them ALL down — not just the tunnel.
// Leaving the game/proxy/bridge alive on Ctrl-C is what caused EADDRINUSE on the
// next launch (their ports stayed held). On Windows a plain kill leaves a child's
// own children (e.g. the bridge's Chromium) orphaned, so tree-kill via taskkill.
const activeChildren = new Set();
const killProc = (proc) => {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === "win32" && proc.pid) {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch {
    /* already gone */
  }
};

const cleanup = () => {
  stopping = true;
  stoppingTunnel = true;
  killProc(tunnel);
  for (const proc of activeChildren) killProc(proc);
  activeChildren.clear();
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => { cleanup(); process.exit(0); });

// --- wait for the game's loopback port before starting proxy/bridge ----------
const waitForPort = (port, host = "127.0.0.1", timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const socket = net.connect(port, host);
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error(`port ${port} never opened`));
        setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });

// --- cloudflared quick tunnel (aimed at the SPECTATOR proxy) -----------------
const startTunnel = () => new Promise((resolve) => {
  const mode = cfg.tunnel || "none";
  try { unlinkSync(PUBLIC_URL_FILE); } catch { /* no stale file */ }
  if (mode === "none" || !existsSync(cfBin)) return resolve(null);

  if (mode === "named" && cfg.tunnelName) {
    console.log(`Starting Cloudflare Tunnel "${cfg.tunnelName}"...`);
    tunnel = spawn(cfBin, ["tunnel", "run", "--url", `http://localhost:${SPECTATOR_PORT}`, cfg.tunnelName], { stdio: "inherit" });
    return resolve(cfg.publicUrl || null);
  }

  console.log("Starting Cloudflare Tunnel (quick) for the live spectator map...");
  tunnel = spawn(cfBin, ["tunnel", "--url", `http://localhost:${SPECTATOR_PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let done = false;
  let acc = "";
  const finish = (u) => { if (!done) { done = true; resolve(u); } };
  const capture = (u) => {
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(PUBLIC_URL_FILE, u); } catch { /* best-effort */ }
  };
  const scan = (buf) => {
    acc += String(buf);
    const m = acc.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      console.log(done ? `Tunnel back up at ${m[0]}` : `Live spectator map: ${m[0]}/?spectator=1`);
      capture(m[0]);
      finish(m[0]);
      acc = "";
    } else if (acc.length > 65536) acc = acc.slice(-4096);
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("error", (e) => { console.warn(`cloudflared failed: ${e.message}`); finish(null); });
  tunnel.on("exit", (code, signal) => {
    if (stoppingTunnel) return;
    console.warn(`Cloudflare Tunnel exited (${signal || `code ${code}`}) — restarting…`);
    setTimeout(() => { if (!stopping) startTunnel(); }, 5000);
  });
  setTimeout(() => finish(null), 120000);
});

// --- per-child supervise with a boot-failure budget --------------------------
async function superviseOne(child) {
  let bootFailures = 0;
  for (;;) {
    if (stopping) return;
    const startedAt = Date.now();
    const code = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [child.file], {
        stdio: "inherit",
        cwd: child.cwd || __dirname,
        env: { ...process.env, ...child.env },
      });
      activeChildren.add(proc);
      proc.on("exit", (c) => { activeChildren.delete(proc); resolve(c ?? 0); });
      proc.on("error", (e) => { activeChildren.delete(proc); console.error(`[${child.name}] failed to spawn: ${e.message}`); resolve(1); });
    });
    if (stopping || code === 0) return;
    const ran = Date.now() - startedAt;
    if (ran >= 15000) bootFailures = 0; // a healthy stretch clears the budget
    if (ran < 15000 && ++bootFailures >= 5) {
      console.error(`[${child.name}] keeps failing to boot — giving up.`);
      // A hard dependency going down should stop the whole node; bot/proxy retry.
      if (child.name === "game" || child.name === "bridge") { cleanup(); process.exit(code || 1); }
      return;
    }
    const backoff = Math.min(1000 * Math.max(1, bootFailures), 15000);
    console.warn(`[${child.name}] exited (code ${code}) — restarting in ${backoff}ms…`);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

// --- boot ---------------------------------------------------------------------
if (!existsSync(GAME_ENTRY)) {
  console.error(`Game server not found at ${GAME_ENTRY}. Set gameDir in discord.config.json to a built game (with server/ and dist/).`);
  process.exit(1);
}

// The world-map vector tiles (~200 MB: country/region/city polygons) are NOT in
// git — they're GitHub Release assets the game fetches at launch. We start
// server.js directly (bypassing the game's own launcher), so ensure them here or
// the map shows only the satellite basemap with no countries. Best-effort and
// bounded: fetch-map-assets.mjs never exits non-zero, so it can't block startup.
const regionsTiles = path.join(GAME_DIR, "public", "assets", "regions.pmtiles");
const fetchScript = path.join(GAME_DIR, "scripts", "fetch-map-assets.mjs");
if (!existsSync(regionsTiles) && existsSync(fetchScript)) {
  console.log("World map tiles missing — downloading them (~200 MB, one time)…");
  spawnSync(process.execPath, [fetchScript, "--ensure"], { cwd: GAME_DIR, stdio: "inherit" });
}

const children = [
  { name: "game", file: GAME_ENTRY, cwd: GAME_DIR, env: { PORT: String(GAME_PORT), HOST: "127.0.0.1" } },
  { name: "proxy", file: path.join(__dirname, "spectator-proxy.mjs"), env: { GAME_PORT: String(GAME_PORT), SPECTATOR_PORT: String(SPECTATOR_PORT) } },
  { name: "bridge", file: path.join(__dirname, "bot-bridge.mjs"), env: { GAME_PORT: String(GAME_PORT), BRIDGE_PORT: String(BRIDGE_PORT) } },
  { name: "bot", file: path.join(__dirname, "bot.mjs"), env: { BRIDGE_PORT: String(BRIDGE_PORT), SPECTATOR_PORT: String(SPECTATOR_PORT) } },
];

console.log("Open Historia — Discord edition starting…");
superviseOne(children[0]); // game (loopback)
try {
  await waitForPort(GAME_PORT);
  console.log(`Game is up on 127.0.0.1:${GAME_PORT}.`);
} catch (e) {
  console.error(e.message);
}
for (const child of children.slice(1)) superviseOne(child); // proxy, bridge, bot
await startTunnel(); // cloudflared -> spectator proxy (child #5)
