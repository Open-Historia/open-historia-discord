/*! Open Historia — Discord edition: the bot. © 2026 Nicholas Krol, MIT. */
// discord.js client that turns a server's votes into moves in a headless game and
// posts the results (events + a live map PNG) back to Discord. The bot's own
// bridge is the ONLY writer; players interact only through Discord + a read-only
// live map. M2 scope: single shared nation, one action ballot per round, timed
// voting with an all-ready / host-close override. Multi-nation factions,
// diplomacy replies, catalysts and unit orders layer on in M4.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, timing } from "./config.mjs";
import { oh, waitForBridge } from "./bridge-client.mjs";
import { ballotId as makeBallotId } from "./ids.mjs";
import * as store from "./persistence.mjs";
import { resolveRound } from "./rounds.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL_FILE = path.join(__dirname, "data", "public-url.txt");
const REGISTER_ONLY = process.argv.includes("--register-only");

const token = CONFIG.discord?.token;
const clientId = CONFIG.discord?.clientId;
const guildId = CONFIG.discord?.guildId;

// --- slash commands ----------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName("startgame").setDescription("Host: start a new game in this channel")
    .addStringOption((o) => o.setName("nation").setDescription("The nation everyone plays (e.g. France)").setRequired(true)),
  new SlashCommandBuilder().setName("propose").setDescription("Propose an action for this round")
    .addStringOption((o) => o.setName("text").setDescription("What should our nation do?").setRequired(true)),
  new SlashCommandBuilder().setName("openvote").setDescription("Host: close proposals and open voting"),
  new SlashCommandBuilder().setName("closevote").setDescription("Host: close voting now and resolve the round"),
  new SlashCommandBuilder().setName("ready").setDescription("Mark yourself ready — voting ends when everyone is"),
  new SlashCommandBuilder().setName("map").setDescription("Post the current world map"),
  new SlashCommandBuilder().setName("live").setDescription("Get the read-only live map link"),
  new SlashCommandBuilder().setName("status").setDescription("Show the current game status"),
  new SlashCommandBuilder().setName("help").setDescription("How to play the Open Historia Discord game"),
  new SlashCommandBuilder().setName("endgame").setDescription("Host: end the current game"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map((c) => c.toJSON()) });
  console.log(`Registered ${commands.length} guild slash commands.`);
}

// --- live URL ----------------------------------------------------------------
function liveUrl() {
  try {
    const u = readFileSync(PUBLIC_URL_FILE, "utf8").trim();
    return u ? `${u.replace(/\/$/, "")}/?spectator=1` : null;
  } catch {
    return null;
  }
}

if (REGISTER_ONLY) {
  await registerCommands();
  process.exit(0);
}

// --- discord client ----------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timers = new Map(); // guildId -> timeout

function embed(title, description, color = 0x6d5aed) {
  return new EmbedBuilder().setTitle(title).setDescription(String(description || "").slice(0, 4000)).setColor(color);
}

async function channelFor(game) {
  if (!game.channelId) return null;
  try {
    return await client.channels.fetch(game.channelId);
  } catch {
    return null;
  }
}

// Post the current map (best-effort) to the game channel.
async function postMap(game, caption) {
  const ch = await channelFor(game);
  if (!ch) return;
  try {
    const { png } = await oh("screenshotMap", { country: game.primaryNation, zoom: 4 });
    const file = new AttachmentBuilder(Buffer.from(png, "base64"), { name: "map.png" });
    await ch.send({ content: caption || undefined, files: [file] });
  } catch (e) {
    await ch.send(`(map unavailable: ${e.message})`);
  }
}

// The single funnel every "voting is over" path calls (timer, all-ready, host).
async function finalize(guildId) {
  const game = store.getGame(guildId);
  if (game.phase !== "VOTING") return;
  clearTimeout(timers.get(guildId));
  timers.delete(guildId);
  store.updateGame(guildId, (g) => { g.phase = "RESOLVING"; });
  const ch = await channelFor(game);
  await ch?.send(embed("⏳ Resolving the round…", "Tallying votes and simulating the world forward.", 0xf5a623));
  let summary;
  try {
    summary = await resolveRound(guildId, oh);
  } catch (e) {
    store.updateGame(guildId, (g) => { g.phase = "COLLECTING"; });
    await ch?.send(embed("Resolution failed", `${e.message}\nProposals are still open — try /closevote again.`, 0xd64646));
    return;
  }
  // POSTING
  store.updateGame(guildId, (g) => { g.round += 1; g.phase = "POSTING"; });
  const events = (summary?.newEvents || []).map((e) => `• **${e.date || ""}** ${e.title}`).join("\n") || "A quiet stretch — nothing major.";
  await ch?.send(embed(`📜 ${game.primaryNation} — ${summary?.gameDate || ""}`, events, 0x4caf50));
  await postMap(store.getGame(guildId), summary?.mapChanged ? "The map has changed:" : undefined);
  if (summary?.fallbackReason) await ch?.send(`⚠️ ${summary.fallbackReason}`);
  // INTERLUDE -> next COLLECTING
  store.updateGame(guildId, (g) => { g.phase = "INTERLUDE"; g.phaseEndsAt = Date.now() + timing.interludeSec * 1000; });
  setTimeout(() => startCollecting(guildId), timing.interludeSec * 1000);
}

async function startCollecting(guildId) {
  const game = store.updateGame(guildId, (g) => { g.phase = "COLLECTING"; g.phaseEndsAt = 0; });
  const ch = await channelFor(game);
  await ch?.send(embed(`🗳️ Round ${game.round + 1} — propose your moves`, `Use \`/propose\` to suggest what **${game.primaryNation}** should do. The host runs \`/openvote\` when proposals are in.`, 0x6d5aed));
}

// Build/refresh the voting ballot message with one button per proposal.
async function openVoting(guildId) {
  const game = store.getGame(guildId);
  const proposals = Object.values(game.ballots).flatMap((b) => b.options);
  const ch = await channelFor(game);
  if (!proposals.length) {
    await ch?.send(embed("No proposals", "Nobody proposed anything — use `/propose` first.", 0xf5a623));
    return;
  }
  const rows = [];
  let row = new ActionRowBuilder();
  proposals.forEach((opt, i) => {
    if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder().setCustomId(`vote:${opt.id}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
  });
  rows.push(row);
  const list = proposals.map((o, i) => `**${i + 1}.** ${o.text}`).join("\n");
  const endsAt = Math.floor((Date.now() + timing.votingWindowSec * 1000) / 1000);
  const msg = await ch?.send({
    embeds: [embed("🗳️ Vote on this round's move", `${list}\n\nVoting closes <t:${endsAt}:R> (or when everyone is \`/ready\`).`, 0x6d5aed)],
    components: rows.slice(0, 5),
  });
  store.updateGame(guildId, (g) => {
    g.phase = "VOTING";
    g.phaseEndsAt = Date.now() + timing.votingWindowSec * 1000;
    g.readySet = [];
    if (msg) g.ballotMessageId = msg.id;
  });
  clearTimeout(timers.get(guildId));
  timers.set(guildId, setTimeout(() => finalize(guildId), timing.votingWindowSec * 1000));
}

// --- reconcile on boot -------------------------------------------------------
async function reconcile() {
  const s = store.load();
  for (const gid of Object.keys(s.guilds)) {
    const game = s.guilds[gid];
    if (!game.active) continue;
    // Replay any ops that a crash left un-applied (idempotent — engine ids are stable).
    const pending = store.pendingOps(gid);
    if (pending.length) {
      console.log(`[reconcile] ${gid}: replaying ${pending.length} pending op(s)`);
      try {
        for (const op of pending) { await oh(op.method, ...op.args); store.markOpApplied(gid, op.opId); }
        store.clearOps(gid);
      } catch (e) {
        console.warn(`[reconcile] ${gid}: op replay failed — ${e.message}`);
      }
    }
    // Re-arm a past-due voting timer immediately.
    if (game.phase === "VOTING") {
      const remaining = Math.max(0, game.phaseEndsAt - Date.now());
      timers.set(gid, setTimeout(() => finalize(gid), remaining));
    }
  }
}

// --- interaction handling ----------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("vote:")) {
      const optionId = interaction.customId.slice(5);
      const gid = interaction.guildId;
      const game = store.getGame(gid);
      if (game.phase !== "VOTING") return interaction.reply({ content: "Voting isn't open right now.", ephemeral: true });
      // Find the ballot holding this option.
      const ballot = Object.values(game.ballots).find((b) => b.options.some((o) => o.id === optionId));
      if (!ballot) return interaction.reply({ content: "That option is no longer available.", ephemeral: true });
      store.recordVote(gid, ballot.id, interaction.user.id, optionId);
      return interaction.reply({ content: "Vote recorded (you can change it by voting again).", ephemeral: true });
    }
    if (!interaction.isChatInputCommand()) return;
    const gid = interaction.guildId;
    const name = interaction.commandName;

    if (name === "help") {
      return interaction.reply({
        embeds: [embed("How to play", [
          "**/startgame nation** — host starts a game (everyone plays that nation).",
          "**/propose** — suggest a move for the round.",
          "**/openvote** — host opens voting on the proposals.",
          "Tap a numbered button to vote; **/ready** to end voting early.",
          "**/closevote** — host resolves the round now.",
          "**/map**, **/live** — see the world; **/status** — current state.",
        ].join("\n"))],
        ephemeral: true,
      });
    }

    if (name === "startgame") {
      const nation = interaction.options.getString("nation", true);
      await interaction.deferReply();
      await oh("setActivePlayers", [nation]);
      store.updateGame(gid, (g) => {
        Object.assign(g, { active: true, round: 0, phase: "COLLECTING", primaryNation: nation, factionNations: [], channelId: interaction.channelId, players: {}, ballots: {}, votes: {}, pendingOps: [] });
      });
      await interaction.editReply(`🌍 New game started — everyone plays **${nation}**. Use \`/propose\` to suggest this round's moves, then the host runs \`/openvote\`.`);
      const url = liveUrl();
      if (url) await interaction.followUp(`🔴 Live read-only map: ${url}`);
      return;
    }

    const game = store.getGame(gid);
    if (["propose", "openvote", "closevote", "ready", "map", "live", "status", "endgame"].includes(name) && !game.active) {
      return interaction.reply({ content: "No game is running here — a host can start one with `/startgame`.", ephemeral: true });
    }

    if (name === "propose") {
      const text = interaction.options.getString("text", true);
      if (game.phase !== "COLLECTING") return interaction.reply({ content: "Proposals are closed for this round.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      // Refine through the engine so the option text is a clean order (falls back offline).
      let refined = text;
      try { const entry = await oh("queueActionFor", "__preview__", text); refined = entry?.title || text; } catch { /* keep raw */ }
      // NOTE: the preview queued an action; clear it so only the VOTED action resolves.
      try { await oh("clearQueuedActions"); } catch { /* ignore */ }
      const bId = makeBallotId({ round: game.round, decisionKey: "action" });
      store.updateGame(gid, (g) => {
        if (!g.ballots[bId]) g.ballots[bId] = { id: bId, kind: "action", decisionKey: "action", nation: g.primaryNation, options: [] };
        const optId = `${bId}:${g.ballots[bId].options.length}`;
        g.ballots[bId].options.push({ id: optId, text, label: refined.slice(0, 60) });
        g.votes[bId] = g.votes[bId] || {};
      });
      return interaction.editReply(`Proposal added: “${refined.slice(0, 80)}”. The host opens voting with \`/openvote\`.`);
    }

    if (name === "openvote") {
      if (game.phase !== "COLLECTING") return interaction.reply({ content: "Voting can only open during proposals.", ephemeral: true });
      await interaction.reply("🗳️ Opening the vote…");
      return openVoting(gid);
    }

    if (name === "closevote") {
      if (game.phase !== "VOTING") return interaction.reply({ content: "There's no open vote to close.", ephemeral: true });
      await interaction.reply("Closing the vote and resolving…");
      return finalize(gid);
    }

    if (name === "ready") {
      if (game.phase !== "VOTING") return interaction.reply({ content: "There's nothing to be ready for right now.", ephemeral: true });
      let everyone = false;
      store.updateGame(gid, (g) => {
        g.readySet = Array.from(new Set([...(g.readySet || []), interaction.user.id]));
        const voters = new Set(Object.values(g.votes).flatMap((v) => Object.keys(v)));
        everyone = voters.size > 0 && g.readySet.length >= voters.size;
      });
      await interaction.reply({ content: "You're marked ready.", ephemeral: true });
      if (everyone) await finalize(gid);
      return;
    }

    if (name === "map") { await interaction.deferReply(); await postMap(game, "Current world:"); return interaction.editReply("🗺️ Posted above."); }
    if (name === "live") { const u = liveUrl(); return interaction.reply(u ? `🔴 Live read-only map: ${u}` : "The tunnel isn't up yet — try again shortly."); }
    if (name === "status") {
      return interaction.reply({ embeds: [embed("Status", [
        `Nation: **${game.primaryNation}**`,
        `Round: **${game.round + 1}**`,
        `Phase: **${game.phase}**`,
        `Proposals this round: **${Object.values(game.ballots).flatMap((b) => b.options).length}**`,
      ].join("\n"))] });
    }
    if (name === "endgame") {
      clearTimeout(timers.get(gid));
      store.updateGame(gid, (g) => { g.active = false; g.phase = "IDLE"; });
      return interaction.reply("🏁 Game ended. Thanks for playing!");
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.deferred || interaction.replied) interaction.editReply(`Error: ${e.message}`).catch(() => {});
    else interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

client.once("ready", async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.warn("command registration failed:", e.message); }
  try { await waitForBridge(); console.log("bridge ready — the bot can drive the game."); } catch (e) { console.warn(e.message); }
  await reconcile();
});

await registerCommands().catch(() => {}); // ensure commands exist even before first ready
await client.login(token);
