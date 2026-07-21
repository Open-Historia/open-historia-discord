/*! Open Historia — Discord edition: bridge RPC client. © 2026 Nicholas Krol, MIT. */
// Thin client bot.mjs uses to drive the headless game. Posts {method,args} to the
// loopback bridge RPC (bot-bridge.mjs) and returns the JSON result. The two run as
// separate supervised processes, so a Chromium crash restarts only the bridge.
import { ports } from "./config.mjs";

const RPC = `http://127.0.0.1:${ports.bridge}`;

export async function oh(method, ...args) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `bridge error on ${method}`);
  return json.result;
}

// True once the headless game has installed window.oh (map ready). bot.mjs polls
// this before starting a game so a command never races an unready bridge.
export async function bridgeReady() {
  try {
    const res = await fetch(`${RPC}/health`, { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    return !!json.ready;
  } catch {
    return false;
  }
}

// Resolve once the bridge is ready (or throw after timeoutMs).
export async function waitForBridge(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await bridgeReady()) return true;
    if (Date.now() > deadline) throw new Error("bridge did not become ready in time");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
