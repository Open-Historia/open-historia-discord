/*! Open Historia — Discord edition: headless game bridge. © 2026 Nicholas Krol, MIT. */
// A headless Playwright Chromium that IS the game's sole writer. It seeds the AI
// key into localStorage using the exact providerConfig.js key names, opens the
// game on loopback in ?bot=1 mode (loopback + same-origin => writes allowed),
// waits for window.oh to install, then exposes a LOOPBACK-ONLY JSON-RPC so the
// separate bot process can invoke window.oh.* and get JSON / PNG back.
//
// Two processes on purpose: Chromium is the crash-prone, memory-heavy component.
// Isolating it means a browser crash restarts only this bridge (run.mjs), while
// the Discord gateway in bot.mjs stays connected (reconnecting the gateway on
// every browser hiccup risks Discord's re-identify rate limits).
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, "..", "discord.config.json");
// BOM-tolerant: PowerShell's default UTF-8 write prepends a BOM that JSON.parse rejects.
const cfg = existsSync(cfgPath)
  ? JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, ""))
  : {};

const GAME = Number(process.env.GAME_PORT || cfg.gamePort || 3000);
const RPC = Number(process.env.BRIDGE_PORT || cfg.bridgePort || 8090);
const ai = cfg.ai || {};
// providerConfig.js derives per-provider storage keys by replacing '-' with '_'
// in the provider value (e.g. 'openai-compatible' -> 'openai_compatible_api_key'),
// while 'api_provider' stores the raw hyphenated value. Reproduce BOTH exactly.
const provider = String(ai.provider || "gemini");
const prefix = provider.replace(/-/g, "_");
const seed = {
  provider,
  prefix,
  apiKey: ai.apiKey || "",
  model: ai.model || "",
  endpoint: ai.endpoint || "",
};

// A dedicated on-disk profile keeps the seeded key + any caches across restarts
// and is gitignored. Loopback only — never served anywhere.
const PROFILE_DIR = path.join(__dirname, "..", "profile");
mkdirSync(PROFILE_DIR, { recursive: true });

let page = null;
let context = null;
let ready = false;

const seedInit = (s) => {
  try {
    localStorage.setItem("api_provider", s.provider); // raw, may be hyphenated
    localStorage.setItem(`${s.prefix}_api_key`, s.apiKey); // e.g. gemini_api_key
    if (s.model) localStorage.setItem(`${s.prefix}_model`, s.model);
    if (s.endpoint) localStorage.setItem(`${s.prefix}_endpoint`, s.endpoint);
  } catch {
    /* localStorage unavailable pre-navigation — the retry after goto covers it */
  }
};

async function launch() {
  ready = false;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1600, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // Seed BEFORE any game JS runs, so getStoredProvider()/getProviderField()
  // read the key on first paint.
  await context.addInitScript(seedInit, seed);
  page = context.pages()[0] || (await context.newPage());
  page.on("crash", () => {
    console.error("bot-bridge: page crashed — exiting for the supervisor to relaunch.");
    process.exit(1);
  });
  await page.goto(`http://127.0.0.1:${GAME}/?bot=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  // The window.oh contract: BotHost installs it once the real MapLibre map first
  // reaches idle (the rAF pump in ?bot=1 makes that happen even though a headless
  // page has requestAnimationFrame paused).
  await page.waitForFunction(() => window.oh && window.oh._installed === true, { timeout: 180000 });
  ready = true;
  console.log("bot-bridge: game ready, window.oh live");
}

// Invoke any window.oh.* method with JSON args; special-case a compact map PNG.
const call = async (method, args = []) => {
  if (!ready || !page) throw new Error("bridge not ready");
  if (method === "screenshotMap") {
    // window.oh.captureMap returns a data URL; hand back raw base64 for Discord.
    const dataUrl = await page.evaluate((o) => window.oh.captureMap(o || {}), args[0] || {});
    return { png: String(dataUrl).replace(/^data:image\/png;base64,/, "") };
  }
  if (method === "screenshotPage") {
    const buf = await page.screenshot({ type: "png" });
    return { png: buf.toString("base64") };
  }
  return await page.evaluate(
    async ({ m, a }) => {
      if (typeof window.oh?.[m] !== "function") throw new Error(`no window.oh.${m}`);
      const r = await window.oh[m](...a);
      return r ?? null; // must be JSON-serializable for page.evaluate to marshal it
    },
    { m: method, a: args },
  );
};

// Loopback-only JSON-RPC. Binding 127.0.0.1 means only the same-machine bot
// process can drive the writer — the RPC is never exposed to the tunnel.
http
  .createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ready }));
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let out;
      try {
        const { method, args } = JSON.parse(body || "{}");
        out = { ok: true, result: await call(method, args || []) };
      } catch (e) {
        out = { ok: false, error: String(e?.message || e) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  })
  .listen(RPC, "127.0.0.1", () => console.log(`bot-bridge RPC :${RPC} (loopback)`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await context?.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });
}

launch().catch((e) => {
  console.error("bot-bridge failed to start:", e?.message || e);
  process.exit(1);
});
