# Open Historia — Discord edition

Host [Open Historia](https://github.com/Open-Historia/open-historia) as a **vote-driven Discord game** on your own computer. Players in your server propose moves, vote on them, and watch the world change on a **read-only live map** — while a headless copy of the real game does all the simulating.

- **Players vote, the bot plays.** `/propose` a move, `/openvote`, tap a button to vote. The winning move is fed into the real game engine and the world advances.
- **A live map anyone can watch.** A Cloudflare Tunnel serves a pannable, click-to-inspect map in read-only spectator mode — no one but the bot can change anything.
- **Multiple nations (optional).** The engine resolves every human faction's orders in one turn with per-nation attribution and a guard that never signs a treaty or cedes land a faction's players didn't order.
- **Self-hosted.** Everything runs on your machine. Your Discord token and AI key never leave it.

## How it stays safe

The design guarantees that **only the bot's own headless browser can write to the game**:

- The game server binds to **`127.0.0.1` only** — it is unreachable from the network.
- The public Cloudflare Tunnel points at a **read-only proxy** that forwards only `GET`/`HEAD`/`OPTIONS` and answers every write (`PUT`/`POST`/`DELETE`) with **403** — so no state-changing request from the internet ever reaches the game.
- The bot drives the game through a **loopback, same-origin** headless Chromium, which is the single write path left open.
- Your **Discord token and AI key** live only in `discord.config.json`, which is **gitignored** and seeded into the bot's private browser — never served to spectators.

## Install (one click)

- **Windows:** double-click `install.bat`.
- **macOS:** double-click `install.command`.
- **Linux:** run `./install.sh`.

The installer collects your Discord bot token, AI provider + key, and a tunnel choice; installs Node dependencies + a headless Chromium; builds the game; writes `discord.config.json` (BOM-free, gitignored); and registers the slash commands.

Before running it: create a bot at the [Discord developer portal](https://discord.com/developers/applications), copy its **token**, **application (client) id**, and your **server (guild) id**, and invite the bot to your server. No privileged intents are required.

Then start it any time with `start.bat` / `./start.sh`.

## Playing

| Command | Who | What |
| --- | --- | --- |
| `/startgame nation:France` | host | begin a game (everyone plays that nation) |
| `/propose text:…` | anyone | suggest a move for the round |
| `/openvote` | host | close proposals, open the vote |
| *(buttons)* / `/ready` | anyone | vote; voting ends when everyone is ready |
| `/closevote` | host | resolve the round now |
| `/map` · `/live` · `/status` | anyone | see the world / get the live link / current state |
| `/endgame` | host | end the game |

## What's in the box

```
app/
  run.mjs             supervisor — spawns & self-heals the 5 processes below
  spectator-proxy.mjs read-only proxy (the security linchpin)
  bot-bridge.mjs      headless Playwright Chromium — the game's sole writer
  bot.mjs             discord.js: commands, voting, round state machine
  rounds.mjs          tally → write-ahead ops → flush (crash-safe, testable)
  persistence.mjs     atomic JSON store + idempotent reconcile
  tally.mjs · ids.mjs · bridge-client.mjs · config.mjs
game/                 the game, as a git submodule (discord-edition branch)
```

The game is included as a **submodule** pinned to the `discord-edition` branch of [`open-historia-discord-game`](https://github.com/Open-Historia/open-historia-discord-game) (a fork of the base game). Clone with `--recurse-submodules`, or the installer will initialise it for you.

## License

MIT © 2026 Nicholas Krol. See [LICENSE](LICENSE).
