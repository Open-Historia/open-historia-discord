#!/usr/bin/env bash
# Open Historia - Discord edition installer (Linux / macOS).
set -e
cd "$(dirname "$0")"

section() { echo; echo "==== $1 ===="; }

section "1/6  Prerequisites (Node.js >= 18, git)"
if ! command -v node >/dev/null 2>&1; then echo "Please install Node.js LTS (>=18) from https://nodejs.org and re-run."; exit 1; fi
if ! command -v git >/dev/null 2>&1; then echo "Please install git and re-run."; exit 1; fi
echo "Node $(node --version), git $(git --version) ready."

section "2/6  Dependencies + headless Chromium"
( cd app && npm install && npx playwright install --with-deps chromium )

section "3/6  The game"
GAME_DIR=""
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
echo "Game: $GAME_DIR"

section "4/6  Discord bot"
read -r -p "Discord bot token: " D_TOKEN
read -r -p "Application (client) id: " D_CLIENT
read -r -p "Server (guild) id: " D_GUILD
read -r -p "Channel id for game posts (optional): " D_CHANNEL

section "5/6  AI provider"
PROVIDERS=(gemini openai anthropic openai-compatible anthropic-compatible)
i=1; for p in "${PROVIDERS[@]}"; do echo "  $i) $p"; i=$((i+1)); done
read -r -p "Choose 1-${#PROVIDERS[@]}: " PN
AI="${PROVIDERS[$((PN-1))]}"
read -r -p "AI API key: " AI_KEY
read -r -p "Model (Enter for default): " AI_MODEL
AI_ENDPOINT=""
case "$AI" in *-compatible) read -r -p "Endpoint URL: " AI_ENDPOINT;; esac

section "6/6  Ports + Cloudflare Tunnel"
read -r -p "Game port (loopback) [3000]: " GAME_PORT; GAME_PORT="${GAME_PORT:-3000}"
read -r -p "Public spectator port [8080]: " SPEC_PORT; SPEC_PORT="${SPEC_PORT:-8080}"
read -r -p "Bridge RPC port (loopback) [8090]: " BRIDGE_PORT; BRIDGE_PORT="${BRIDGE_PORT:-8090}"
TUNNEL_MODE="none"; TUNNEL_NAME=""; PUBLIC_URL=""
read -r -p "Set up a Cloudflare Tunnel for the live map? [Y/n]: " USE_T
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
