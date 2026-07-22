#!/usr/bin/env bash
# Open Historia - Discord edition installer (Linux / macOS).
set -e
cd "$(dirname "$0")"

section() { echo; echo "==== $1 ===="; }

# --- Autofill from an existing config: re-runs never make you re-enter. -------
# cfg <dotted.path> prints the saved value (or empty). ask/asksecret prompt with
# that value as the default (Enter keeps it).
cfg() {
  [ -f discord.config.json ] || { echo ""; return; }
  node -e "try{const c=JSON.parse(require('fs').readFileSync('discord.config.json','utf8').replace(/^﻿/,''));const v='$1'.split('.').reduce((o,k)=>o&&o[k],c);process.stdout.write(v==null?'':String(v))}catch(e){}" 2>/dev/null || echo ""
}
ask() { # ask "label" "default"
  local d="$2" v
  if [ -n "$d" ]; then read -r -p "$1 [$d]: " v; else read -r -p "$1: " v; fi
  echo "${v:-$d}"
}
asksecret() { # asksecret "label" "current"
  local c="$2" v
  if [ -n "$c" ]; then read -r -p "$1 [saved - Enter to keep]: " v; else read -r -p "$1: " v; fi
  echo "${v:-$c}"
}
[ -f discord.config.json ] && echo "Found your saved discord.config.json - press Enter at any prompt to keep the saved value."

section "1/6  Prerequisites (Node.js >= 18, git)"
if ! command -v node >/dev/null 2>&1; then echo "Please install Node.js LTS (>=18) from https://nodejs.org and re-run."; exit 1; fi
if ! command -v git >/dev/null 2>&1; then echo "Please install git and re-run."; exit 1; fi
echo "Node $(node --version), git $(git --version) ready."

section "2/6  Dependencies + headless Chromium"
( cd app && npm install && npx playwright install --with-deps chromium )

section "3/6  The game"
GAME_DIR=""
SAVED_GAME="$(cfg gameDir)"
if [ -n "$SAVED_GAME" ] && [ -d "$SAVED_GAME/dist" ]; then
  KEEP="$(ask "Reuse the built game at $SAVED_GAME? (y/n)" "y")"
  case "$KEEP" in [Yy]*) GAME_DIR="$SAVED_GAME"; echo "Reusing existing build.";; esac
fi
if [ -z "$GAME_DIR" ]; then
  if [ -f game/server/server.js ]; then
    echo "Building the bundled game submodule..."
    ( cd game && git submodule update --init --recursive || true && npm ci && npm run build )
    GAME_DIR="$(cd game && pwd)"
  else
    read -r -p "Game: (1) clone & build the discord-edition fork  (2) existing built path [1]: " MODE
    if [ "$MODE" = "2" ]; then
      read -r -p "Path to a built game (contains server/ and dist/): " GAME_DIR
    else
      git clone -b discord-edition https://github.com/Open-Historia/open-historia-discord-game game
      ( cd game && npm ci && npm run build )
      GAME_DIR="$(cd game && pwd)"
    fi
  fi
fi
echo "Game: $GAME_DIR"

# World-map vector tiles (~200 MB) ship as GitHub Release assets, not in git.
# Without them the map is only the satellite basemap. Fetch them now (idempotent).
if [ -f "$GAME_DIR/scripts/fetch-map-assets.mjs" ] && [ ! -f "$GAME_DIR/public/assets/regions.pmtiles" ]; then
  echo "Downloading world-map tiles (~200 MB, one time)..."
  ( cd "$GAME_DIR" && node scripts/fetch-map-assets.mjs --ensure )
fi

section "4/6  Discord bot"
D_TOKEN="$(asksecret "Discord bot token" "$(cfg discord.token)")"
D_CLIENT="$(ask "Application (client) id" "$(cfg discord.clientId)")"
D_GUILD="$(ask "Server (guild) id" "$(cfg discord.guildId)")"
D_CHANNEL="$(ask "Channel id for game posts (optional)" "$(cfg discord.channelId)")"

section "5/6  AI provider"
PROVIDERS=(gemini openai anthropic openai-compatible anthropic-compatible)
DEF_AI="$(cfg ai.provider)"
i=1; for p in "${PROVIDERS[@]}"; do echo "  $i) $p"; i=$((i+1)); done
AI=""
while [ -z "$AI" ]; do
  if [ -n "$DEF_AI" ]; then read -r -p "Choose 1-${#PROVIDERS[@]} [keep $DEF_AI]: " PN; else read -r -p "Choose 1-${#PROVIDERS[@]}: " PN; fi
  if [ -z "$PN" ] && [ -n "$DEF_AI" ]; then AI="$DEF_AI"
  elif [ "$PN" -ge 1 ] 2>/dev/null && [ "$PN" -le "${#PROVIDERS[@]}" ] 2>/dev/null; then AI="${PROVIDERS[$((PN-1))]}"; fi
done
AI_KEY="$(asksecret "AI API key" "$(cfg ai.apiKey)")"
AI_MODEL="$(ask "Model (Enter for default)" "$(cfg ai.model)")"
AI_ENDPOINT=""
case "$AI" in *-compatible) AI_ENDPOINT="$(ask "Endpoint URL" "$(cfg ai.endpoint)")";; esac

section "6/6  Ports + Cloudflare Tunnel"
GAME_PORT="$(ask "Game port (loopback)" "$(cfg gamePort)")"; GAME_PORT="${GAME_PORT:-3000}"
SPEC_PORT="$(ask "Public spectator port" "$(cfg spectatorPort)")"; SPEC_PORT="${SPEC_PORT:-8080}"
BRIDGE_PORT="$(ask "Bridge RPC port (loopback)" "$(cfg bridgePort)")"; BRIDGE_PORT="${BRIDGE_PORT:-8090}"
TUNNEL_MODE="none"; TUNNEL_NAME=""; PUBLIC_URL=""
DEF_T="Y"; [ "$(cfg tunnel)" = "none" ] && DEF_T="n"
USE_T="$(ask "Set up a Cloudflare Tunnel for the live map? [Y/n]" "$DEF_T")"
if [[ ! "$USE_T" =~ ^[Nn] ]]; then
  CF="app/cloudflared"
  if [ ! -f "$CF" ]; then
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"
    case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac
    echo "Downloading cloudflared..."
    curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${OS}-${ARCH}" -o "$CF" && chmod +x "$CF"
  fi
  TUNNEL_MODE="quick"
fi

# BOM-free config
cat > discord.config.json <<EOF
{
  "discord": { "token": "$D_TOKEN", "clientId": "$D_CLIENT", "guildId": "$D_GUILD", "channelId": "$D_CHANNEL" },
  "ai": { "provider": "$AI", "apiKey": "$AI_KEY", "model": "$AI_MODEL", "endpoint": "$AI_ENDPOINT" },
  "gameDir": "$GAME_DIR",
  "gamePort": $GAME_PORT, "spectatorPort": $SPEC_PORT, "bridgePort": $BRIDGE_PORT,
  "tunnel": "$TUNNEL_MODE", "tunnelName": "$TUNNEL_NAME", "publicUrl": "$PUBLIC_URL"
}
EOF

cat > start.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node app/run.mjs
EOF
chmod +x start.sh

echo "Registering slash commands..."
( cd app && node bot.mjs --register-only )

echo
echo "================= Setup complete! ================="
echo "  Start any time: ./start.sh"
echo "  In your server: /startgame nation:France  then  /propose ... /openvote"
echo "  Your Discord token + AI key live only in discord.config.json (gitignored)."
echo "==================================================="
