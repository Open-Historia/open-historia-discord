/*! Open Historia — Discord edition: read-only spectator proxy. © 2026 Nicholas Krol, MIT. */
// THE SECURITY LINCHPIN. A tiny reverse proxy that forwards ONLY GET/HEAD/OPTIONS
// to the loopback-bound game server and 403s every state-changing method, so the
// public Cloudflare tunnel (which points HERE, never at the game) can never write.
// It also lands visitors in the game's read-only spectator mode (?spectator=1).
//
// Why this is the sole-writer guarantee (ties to the game's server/security.js
// crossOriginWriteAllowed): the game permits a write only when the request has no
// Origin AND comes from loopback, OR its Origin host equals the Host header. A
// cloudflared tunnel aimed straight at the game satisfies BOTH (cloudflared dials
// the origin from localhost; the browser's Origin becomes the game's Host) — that
// is the internet-wide-write hole. We close it two ways: (1) run.mjs starts the
// game with HOST=127.0.0.1 so the ONLY TCP path from outside is through cloudflared,
// and cloudflared is aimed at THIS proxy; (2) this proxy answers writes with 403
// itself, so PUT/POST/DELETE never reach Express at all. The game's loopback/
// same-origin allowances are therefore moot for public traffic — no write ever
// arrives. The bot's own headless Chromium is exempt because it connects directly
// to 127.0.0.1:GAME (loopback + same-origin), making the bridge the ONLY writer.
import http from "node:http";

const GAME = Number(process.env.GAME_PORT || 3000);
const PORT = Number(process.env.SPECTATOR_PORT || 8080);
// Only these reach the game. Everything else dies here with a 403.
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const server = http.createServer((req, res) => {
  if (!SAFE.has((req.method || "").toUpperCase())) {
    // The linchpin: a public visitor can never cause a write to reach the game.
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("Open Historia spectator view is read-only.");
  }

  let pathname = req.url || "/";
  try {
    const u = new URL(req.url, "http://x");
    // Land the bare SPA root in read-only spectator mode. The game reads
    // ?spectator=1 via App.jsx and self-hides every write control.
    if (u.pathname === "/" && !u.searchParams.has("spectator")) {
      res.writeHead(302, { location: "/?spectator=1" });
      return res.end();
    }
    pathname = req.url;
  } catch {
    /* keep the raw url */
  }

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: GAME,
      method: req.method,
      path: pathname,
      // Rewrite Host so the game sees a loopback, same-origin request.
      headers: { ...req.headers, host: `127.0.0.1:${GAME}` },
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("game server unreachable");
  });
  req.pipe(upstream);
});

// Bind all interfaces: this port is what the tunnel (and, if the operator opts
// for direct exposure, the LAN) reaches. Only safe methods ever get through.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`spectator proxy :${PORT} -> 127.0.0.1:${GAME} (GET/HEAD/OPTIONS only; writes 403)`);
});
