/*! Open Historia — Discord edition: the bot. © 2026 Nicholas Krol, MIT. */
// discord.js client that turns a server's votes into moves in a headless game and
// posts the results (events + a live map PNG) back to Discord. The bot's own
// bridge is the ONLY writer; players interact only through Discord + a read-only
// live map.
//
// Single nation  -> everything happens in the channel /startgame was run in.
// Multiple nations -> each faction gets a role + private war-room; players propose
// and vote there, and ONE jump resolves every faction's winning orders together
// (per-nation attribution is enforced by the game engine, workstream B).
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
  PermissionFlagsBits,
} from "discord.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, timing } from "./config.mjs";
import { oh, waitForBridge } from "./bridge-client.mjs";
import { ballotId as makeBallotId } from "./ids.mjs";
import * as store from "./persistence.mjs";
import { resolveRound } from "./rounds.mjs";
import { provisionFactions, assignNation, nationForChannel } from "./factions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL_FILE = path.join(__dirname, "data", "public-url.txt");
const REGISTER_ONLY = process.argv.includes("--register-only");

const token = CONFIG.discord?.token;
const clientId = CONFIG.discord?.clientId;
const guildId = CONFIG.discord?.guildId;

// --- slash commands ----------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName("startgame").setDescription("Host: start a game")
    .addStringOption((o) => o.setName("nations").setDescription("Comma-separated nations (one = solo, many = teams)").setRequired(true)),
  new SlashCommandBuilder().setName("join").setDescription("Join the game (so the round waits for you)")
    .addStringOption((o) => o.setName("nation").setDescription("Which nation to play (team games only)").setRequired(false)),
  new SlashCommandBuilder().setName("leave").setDescription("Leave your current nation"),
  new SlashCommandBuilder().setName("propose").setDescription("Propose an action for your nation this round")
    .addStringOption((o) => o.setName("text").setDescription("What should your nation do?").setRequired(true)),
  new SlashCommandBuilder().setName("forces").setDescription("Propose a military order (deploy / move / attack)")
    .addStringOption((o) => o.setName("order").setDescription("deploy | move | attack").setRequired(true)
      .addChoices({ name: "deploy", value: "deploy" }, { name: "move", value: "move" }, { name: "attack", value: "attack" }))
    .addStringOption((o) => o.setName("detail").setDescription("e.g. '2 infantry to the Rhineland'").setRequired(true)),
  new SlashCommandBuilder().setName("diplomacy").setDescription("Diplomacy: open / reply / list")
    .addStringOption((o) => o.setName("action").setDescription("open | reply | list").setRequired(true)
      .addChoices({ name: "open", value: "open" }, { name: "reply", value: "reply" }, { name: "list", value: "list" }))
    .addStringOption((o) => o.setName("target").setDescription("Chat id (reply) or nation (open)"))
    .addStringOption((o) => o.setName("message").setDescription("Message text (open / reply)")),
  new SlashCommandBuilder().setName("openvote").setDescription("Host: close proposals and open voting"),
  new SlashCommandBuilder().setName("closevote").setDescription("Host: close voting now and resolve the round"),
  new SlashCommandBuilder().setName("ready").setDescription("Mark yourself ready — voting ends when everyone is"),
  new SlashCommandBuilder().setName("catalyst").setDescription("Host: put the active catalyst to a vote"),
  new SlashCommandBuilder().setName("inspect").setDescription("Inspect a region's owner")
    .addStringOption((o) => o.setName("region").setDescription("Region name").setRequired(true)),
  new SlashCommandBuilder().setName("country").setDescription("A country's stat sheet")
    .addStringOption((o) => o.setName("name").setDescription("Country name").setRequired(true)),
  new SlashCommandBuilder().setName("map").setDescription("Post the current world map")
    .addStringOption((o) => o.setName("focus").setDescription("Region or country to center on")),
  new SlashCommandBuilder().setName("live").setDescription("Get the read-only live map link"),
  new SlashCommandBuilder().setName("status").setDescription("Show the current game status"),
  new SlashCommandBuilder().setName("help").setDescription("How to play"),
  new SlashCommandBuilder().setName("endgame").setDescription("Host: end the current game"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map((c) => c.toJSON()) });
  console.log(`Registered ${commands.length} guild slash commands.`);
}

// --- helpers -----------------------------------------------------------------
function liveUrl() {
  try {
    const u = readFileSync(PUBLIC_URL_FILE, "utf8").trim();
    return u ? `${u.replace(/\/$/, "")}/?spectator=1` : null;
  } catch {
    return null;
  }
}

const isMulti = (game) => (game.factions || []).length > 0;
const isHost = (interaction) => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

if (REGISTER_ONLY) {
  await registerCommands();
  process.exit(0);
}

// Only the (non-privileged) Guilds intent. Slash-command interactions carry the
// acting member in their payload, and role add/remove is a REST call gated by the
// Manage Roles permission — so no privileged Server Members intent is needed.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timers = new Map(); // guildId -> voting timeout

function embed(title, description, color = 0x6d5aed) {
  return new EmbedBuilder().setTitle(title).setDescription(String(description || "").slice(0, 4000)).setColor(color);
}

const fetchChannel = async (id) => { try { return id ? await client.channels.fetch(id) : null; } catch { return null; } };

// The channel a faction proposes/votes in: its war-room, or (solo) the game channel.
const nationChannelId = (game, nation) =>
  isMulti(game) ? game.factions.find((f) => f.nation === nation)?.channelId : game.channelId;

// Where round-wide summaries go: #oh-world (multi) or the single channel (solo).
const feedChannelId = (game) => (isMulti(game) ? game.worldChannelId : game.channelId);

async function send(channelId, payload) {
  const ch = await fetchChannel(channelId);
  if (ch) return ch.send(payload).catch(() => null);
  return null;
}

async function postMap(game, focus, channelId) {
  try {
    const opts = focus ? { region: focus, zoom: 4 } : { world: true };
    const { png } = await oh("screenshotMap", opts);
    const file = new AttachmentBuilder(Buffer.from(png, "base64"), { name: "map.png" });
    await send(channelId || feedChannelId(game), { files: [file] });
  } catch (e) {
    await send(channelId || feedChannelId(game), `(map unavailable: ${e.message})`);
  }
}

// --- round lifecycle ---------------------------------------------------------
async function startCollecting(guildId) {
  const game = store.updateGame(guildId, (g) => { g.phase = "COLLECTING"; g.phaseEndsAt = 0; g.ballots = {}; g.votes = {}; });
  const round = game.round + 1;
  if (isMulti(game)) {
    for (const f of game.factions) {
      await send(f.channelId, embed(`🗳️ Round ${round} — ${f.nation}`, `Propose **${f.nation}**'s moves with \`/propose\` (or \`/forces\` for military orders). The host runs \`/openvote\` when ready.`, 0x6d5aed));
    }
    await send(game.worldChannelId, embed(`🗳️ Round ${round} — proposals open`, "Each nation is planning in its war-room.", 0x6d5aed));
  } else {
    await send(game.channelId, embed(`🗳️ Round ${round} — propose your moves`, `\`/join\` to play (or just \`/propose\` / \`/forces\` — that joins you too). The host runs \`/openvote\` when ready; the round waits for everyone who joined to \`/ready\`.`, 0x6d5aed));
  }
}

// Add a proposal to the acting nation's action ballot.
function addProposal(guildId, nation, text, label) {
  const game = store.getGame(guildId);
  const bId = makeBallotId({ round: game.round, nation, decisionKey: "action" });
  store.updateGame(guildId, (g) => {
    if (!g.ballots[bId]) g.ballots[bId] = { id: bId, kind: "action", decisionKey: "action", nation, options: [] };
    const optId = `${bId}:${g.ballots[bId].options.length}`;
    g.ballots[bId].options.push({ id: optId, text, label: (label || text).slice(0, 60) });
    g.votes[bId] = g.votes[bId] || {};
  });
}

// Post a ballot message (one numbered button per option) to a channel.
async function postBallot(channelId, title, ballot, footer) {
  const rows = [];
  let row = new ActionRowBuilder();
  ballot.options.forEach((opt, i) => {
    if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder().setCustomId(`vote:${opt.id}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
  });
  rows.push(row);
  const list = ballot.options.map((o, i) => `**${i + 1}.** ${o.label}`).join("\n");
  return send(channelId, { embeds: [embed(title, `${list}\n\n${footer}`, 0x6d5aed)], components: rows.slice(0, 5) });
}

async function openVoting(guildId) {
  const game = store.getGame(guildId);
  const endsAt = Math.floor((Date.now() + timing.votingWindowSec * 1000) / 1000);
  const footer = `Voting closes <t:${endsAt}:R> (or when everyone is \`/ready\`).`;
  let any = false;
  // One action ballot per nation, posted in that nation's channel.
  const nations = isMulti(game) ? game.factions.map((f) => f.nation) : [game.primaryNation];
  for (const nation of nations) {
    const ballot = Object.values(game.ballots).find((b) => b.nation === nation && b.kind === "action");
    if (!ballot || !ballot.options.length) continue;
    any = true;
    await postBallot(nationChannelId(game, nation), `🗳️ ${nation} — vote on this round's move`, ballot, footer);
  }
  if (!any) { await send(feedChannelId(game), embed("No proposals", "Nobody proposed anything — use `/propose` first.", 0xf5a623)); return; }
  store.updateGame(guildId, (g) => { g.phase = "VOTING"; g.phaseEndsAt = Date.now() + timing.votingWindowSec * 1000; g.readySet = []; });
  clearTimeout(timers.get(guildId));
  timers.set(guildId, setTimeout(() => finalize(guildId), timing.votingWindowSec * 1000));
}

// The single funnel every "voting is over" path calls (timer, all-ready, host).
async function finalize(guildId) {
  const game = store.getGame(guildId);
  if (game.phase !== "VOTING") return;
  clearTimeout(timers.get(guildId));
  timers.delete(guildId);
  store.updateGame(guildId, (g) => { g.phase = "RESOLVING"; });
  await send(feedChannelId(game), embed("⏳ Resolving the round…", "Tallying every nation's votes and simulating the world forward.", 0xf5a623));
  let summary;
  try {
    summary = await resolveRound(guildId, oh);
  } catch (e) {
    store.updateGame(guildId, (g) => { g.phase = "COLLECTING"; });
    await send(feedChannelId(game), embed("Resolution failed", `${e.message}\nProposals are still open — try /closevote again.`, 0xd64646));
    return;
  }
  store.updateGame(guildId, (g) => { g.round += 1; g.phase = "POSTING"; });
  const events = (summary?.newEvents || []).map((e) => `• **${e.date || ""}** ${e.title}`).join("\n") || "A quiet stretch — nothing major.";
  await send(feedChannelId(game), embed(`📜 ${summary?.gameDate || ""}`, events, 0x4caf50));
  await postMap(store.getGame(guildId), null, feedChannelId(game));
  if (summary?.fallbackReason) await send(feedChannelId(game), `⚠️ ${summary.fallbackReason}`);
  // Interlude: surface any decisions the jump raised (catalyst, diplomacy).
  await surfacePendingDecisions(guildId, summary);
  store.updateGame(guildId, (g) => { g.phase = "INTERLUDE"; g.phaseEndsAt = Date.now() + timing.interludeSec * 1000; });
  setTimeout(() => startCollecting(guildId), timing.interludeSec * 1000);
}

// After a jump, tell players what awaits: an active catalyst and any chats a human
// nation must answer. Catalyst -> a #oh-world poll; diplomacy -> a war-room nudge.
async function surfacePendingDecisions(guildId, summary) {
  const game = store.getGame(guildId);
  try {
    const pending = await oh("listPendingDecisions");
    if (summary?.activeCatalyst?.choices?.length || pending?.catalyst?.choices?.length) {
      const cat = pending?.catalyst || summary.activeCatalyst;
      await send(feedChannelId(game), embed(`⚡ ${cat.title || "A catalyst unfolds"}`, `${cat.opening || ""}\n\nThe host can put this to a vote with \`/catalyst\`.`, 0xff9800));
    }
    for (const chat of pending?.chatsAwaitingReply || []) {
      // The recipient nation (a human faction in the chat that isn't the last speaker).
      const recipients = (chat.countries || []).map((c) => c.name).filter((n) => (game.factions || []).some((f) => f.nation === n) || n === game.primaryNation);
      const last = chat.last?.speaker || "";
      const recipient = recipients.find((n) => n !== last) || recipients[0];
      if (!recipient) continue;
      await send(nationChannelId(game, recipient), embed("💬 A message awaits a reply", `**${last}** wrote to **${recipient}**:\n> ${(chat.last?.text || "").slice(0, 300)}\n\nReply with \`/diplomacy reply target:${chat.id} message:…\`.`, 0x2196f3));
    }
  } catch {
    /* pending-decisions is best-effort */
  }
}

// --- reconcile on boot -------------------------------------------------------
async function reconcile() {
  const s = store.load();
  for (const gid of Object.keys(s.guilds)) {
    const game = s.guilds[gid];
    if (!game.active) continue;
    const pending = store.pendingOps(gid);
    if (pending.length) {
      console.log(`[reconcile] ${gid}: replaying ${pending.length} pending op(s)`);
      try { for (const op of pending) { await oh(op.method, ...op.args); store.markOpApplied(gid, op.opId); } store.clearOps(gid); }
      catch (e) { console.warn(`[reconcile] ${gid}: replay failed — ${e.message}`); }
    }
    if (game.phase === "VOTING") {
      const remaining = Math.max(0, game.phaseEndsAt - Date.now());
      timers.set(gid, setTimeout(() => finalize(gid), remaining));
    }
  }
}

// --- interactions ------------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("vote:")) return handleVote(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("cat:")) return handleCatalystVote(interaction);
    if (!interaction.isChatInputCommand()) return;
    return handleCommand(interaction);
  } catch (e) {
    console.error("interaction error:", e);
    const msg = `Error: ${e.message}`;
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

async function handleVote(interaction) {
  const optionId = interaction.customId.slice(5);
  const gid = interaction.guildId;
  const game = store.getGame(gid);
  if (game.phase !== "VOTING") return interaction.reply({ content: "Voting isn't open right now.", ephemeral: true });
  const ballot = Object.values(game.ballots).find((b) => b.options.some((o) => o.id === optionId));
  if (!ballot) return interaction.reply({ content: "That option is no longer available.", ephemeral: true });
  const current = game.players[interaction.user.id];
  // In a team game you can only vote on your own nation's ballot.
  if (isMulti(game) && current && current !== ballot.nation) {
    return interaction.reply({ content: `You're on ${current}'s team — you can only vote on ${current}'s moves.`, ephemeral: true });
  }
  // Voting counts as joining: whoever votes is a participant the round waits on.
  if (!current) store.setPlayerNation(gid, interaction.user.id, ballot.nation || game.primaryNation);
  store.recordVote(gid, ballot.id, interaction.user.id, optionId);
  return interaction.reply({ content: "Vote recorded — you're in this game now (change it by voting again).", ephemeral: true });
}

async function handleCatalystVote(interaction) {
  const gid = interaction.guildId;
  const idx = interaction.customId.slice(4);
  store.recordVote(gid, "catalyst", interaction.user.id, idx);
  return interaction.reply({ content: "Catalyst vote recorded.", ephemeral: true });
}

async function handleCommand(interaction) {
  const gid = interaction.guildId;
  const name = interaction.commandName;

  if (name === "help") {
    return interaction.reply({ embeds: [embed("How to play", [
      "**/startgame nations:France,Germany** — host starts a game. One nation = solo; several = teams (each gets a private war-room).",
      "**/join** — join the game (add `nation:France` in a team game). Proposing or voting joins you automatically.",
      "**/propose** / **/forces** — suggest a move or a military order.",
      "**/openvote** (host) — open voting; tap a number to vote. **/ready** — the round resolves once every joined player is ready (or the timer runs out).",
      "**/closevote** (host) — resolve the round now.",
      "**/diplomacy**, **/catalyst**, **/inspect**, **/country**, **/map** (whole world; `focus:France` to zoom), **/live**, **/status**.",
    ].join("\n"))], ephemeral: true });
  }

  if (name === "startgame") {
    if (!isHost(interaction)) return interaction.reply({ content: "Only a host (Manage Server) can start a game.", ephemeral: true });
    const nations = interaction.options.getString("nations", true).split(",").map((n) => n.trim()).filter(Boolean).slice(0, 16);
    if (!nations.length) return interaction.reply({ content: "Name at least one nation.", ephemeral: true });
    await interaction.deferReply();
    await oh("setActivePlayers", nations);
    let provisioned = { worldChannelId: "", factions: [] };
    if (nations.length > 1) {
      try { provisioned = await provisionFactions(interaction.guild, nations); }
      catch (e) { return interaction.editReply(`Couldn't set up teams (the bot needs Manage Roles + Manage Channels): ${e.message}`); }
    }
    store.updateGame(gid, (g) => {
      Object.assign(g, store.getGame(gid), {
        active: true, round: 0, phase: "COLLECTING",
        primaryNation: nations[0], factionNations: nations.slice(1),
        channelId: interaction.channelId, worldChannelId: provisioned.worldChannelId, factions: provisioned.factions,
        players: {}, ballots: {}, votes: {}, pendingOps: [],
      });
    });
    const url = liveUrl();
    await interaction.editReply(nations.length > 1
      ? `🌍 New game — **${nations.join(", ")}**. Each nation has a war-room; players \`/join\` a team, then \`/propose\`.${url ? `\n🔴 Live map: ${url}` : ""}`
      : `🌍 New game — everyone plays **${nations[0]}**. \`/propose\` this round's moves, then the host runs \`/openvote\`.${url ? `\n🔴 Live map: ${url}` : ""}`);
    await startCollecting(gid);
    return;
  }

  const game = store.getGame(gid);
  if (!game.active && !["live", "help"].includes(name)) {
    return interaction.reply({ content: "No game is running — a host can start one with `/startgame`.", ephemeral: true });
  }

  if (name === "join") {
    await interaction.deferReply({ ephemeral: true });
    if (!isMulti(game)) {
      // Solo game: join the shared nation so the round counts you and waits for
      // your /ready. No role needed.
      store.setPlayerNation(gid, interaction.user.id, game.primaryNation);
      return interaction.editReply(`You joined the game as **${game.primaryNation}**. \`/propose\` moves, vote, then \`/ready\`.`);
    }
    const nation = interaction.options.getString("nation");
    if (!nation) return interaction.editReply("This is a team game — pick a nation, e.g. `/join nation:France`.");
    try { const got = await assignNation(interaction.guild, interaction.member, nation); return interaction.editReply(`You joined **${got}**. Head to its war-room to propose and vote.`); }
    catch (e) { return interaction.editReply(e.message); }
  }
  if (name === "leave") {
    store.setPlayerNation(gid, interaction.user.id, null);
    const roleIds = (game.factions || []).map((f) => f.roleId).filter((id) => interaction.member.roles.cache.has(id));
    await interaction.member.roles.remove(roleIds).catch(() => {});
    return interaction.reply({ content: "You left your nation.", ephemeral: true });
  }

  if (name === "propose" || name === "forces") {
    if (game.phase !== "COLLECTING") return interaction.reply({ content: "Proposals are closed for this round.", ephemeral: true });
    const nation = isMulti(game) ? nationForChannel(game, interaction.channelId) || game.players[interaction.user.id] : game.primaryNation;
    if (!nation) return interaction.reply({ content: "Propose from your nation's war-room (or `/join` a nation first).", ephemeral: true });
    let text = interaction.options.getString(name === "forces" ? "detail" : "text", true);
    if (name === "forces") text = `${interaction.options.getString("order", true)} ${text}`;
    await interaction.deferReply({ ephemeral: true });
    store.setPlayerNation(gid, interaction.user.id, nation); // proposing joins you in
    let label = text;
    try { const entry = await oh("queueActionFor", "__preview__", text); label = entry?.title || text; await oh("clearQueuedActions"); } catch { /* keep raw */ }
    addProposal(gid, nation, text, label);
    return interaction.editReply(`Proposal added for **${nation}**: “${label.slice(0, 80)}”.`);
  }

  if (name === "openvote") {
    if (!isHost(interaction)) return interaction.reply({ content: "Only a host can open voting.", ephemeral: true });
    if (game.phase !== "COLLECTING") return interaction.reply({ content: "Voting can only open during proposals.", ephemeral: true });
    await interaction.reply("🗳️ Opening the vote…");
    return openVoting(gid);
  }
  if (name === "closevote") {
    if (!isHost(interaction)) return interaction.reply({ content: "Only a host can close the vote.", ephemeral: true });
    if (game.phase !== "VOTING") return interaction.reply({ content: "There's no open vote to close.", ephemeral: true });
    await interaction.reply("Closing the vote and resolving…");
    return finalize(gid);
  }
  if (name === "ready") {
    if (game.phase !== "VOTING") return interaction.reply({ content: "There's nothing to be ready for right now.", ephemeral: true });
    let everyone = false;
    store.updateGame(gid, (g) => {
      if (!g.players[interaction.user.id]) g.players[interaction.user.id] = g.primaryNation; // readying joins you
      g.readySet = Array.from(new Set([...(g.readySet || []), interaction.user.id]));
      // The round waits for the PARTICIPANTS (everyone who joined / proposed /
      // voted / readied) — not every random voter, and not people who never
      // touched the game. Timer is still the backstop.
      const participants = Object.keys(g.players);
      everyone = participants.length > 0 && participants.every((id) => g.readySet.includes(id));
    });
    const g2 = store.getGame(gid);
    await interaction.reply({ content: `You're ready (${g2.readySet.length}/${Object.keys(g2.players).length} players).`, ephemeral: true });
    if (everyone) await finalize(gid);
    return;
  }

  if (name === "catalyst") {
    if (!isHost(interaction)) return interaction.reply({ content: "Only a host can call a catalyst vote.", ephemeral: true });
    await interaction.deferReply();
    const pending = await oh("listPendingDecisions");
    const cat = pending?.catalyst;
    if (!cat?.choices?.length) return interaction.editReply("No active catalyst to vote on.");
    store.updateGame(gid, (g) => { g.catalystChoices = cat.choices; g.votes = { ...g.votes, catalyst: {} }; });
    const rows = [new ActionRowBuilder()];
    cat.choices.slice(0, 5).forEach((c, i) => rows[0].addComponents(new ButtonBuilder().setCustomId(`cat:${i}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Secondary)));
    const list = cat.choices.map((c, i) => `**${i + 1}.** ${c}`).join("\n");
    await interaction.editReply({ embeds: [embed(`⚡ ${cat.title || "Catalyst"}`, `${cat.opening || ""}\n\n${list}\n\nVote, then the host runs \`/catalyst\` again to resolve.`, 0xff9800)], components: rows });
    // Second /catalyst resolves if a vote already exists.
    if (Object.keys(game.votes?.catalyst || {}).length) {
      const votes = game.votes.catalyst;
      const counts = {};
      for (const v of Object.values(votes)) counts[v] = (counts[v] || 0) + 1;
      const bestIdx = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bestIdx != null) { const choiceText = cat.choices[Number(bestIdx)]; const r = await oh("advanceCatalyst", choiceText); await send(feedChannelId(game), embed("⚡ Catalyst resolved", r?.resolved ? (r.newEvents || []).map((e) => `• ${e.title}`).join("\n") || "The scene resolves." : "The scene continues…", 0xff9800)); }
    }
    return;
  }

  if (name === "diplomacy") {
    const action = interaction.options.getString("action", true);
    if (action === "list") {
      const pending = await oh("listPendingDecisions");
      const lines = (pending?.chatsAwaitingReply || []).map((c) => `• \`${c.id}\` ${c.countries?.map((x) => x.name).join(" ↔ ")}: “${(c.last?.text || "").slice(0, 60)}”`).join("\n") || "No open conversations awaiting a reply.";
      return interaction.reply({ embeds: [embed("💬 Diplomacy", lines)], ephemeral: true });
    }
    const nation = isMulti(game) ? game.players[interaction.user.id] : game.primaryNation;
    if (!nation) return interaction.reply({ content: "Join a nation first (`/join`).", ephemeral: true });
    const message = interaction.options.getString("message");
    if (action === "reply") {
      const chatId = interaction.options.getString("target");
      if (!chatId || !message) return interaction.reply({ content: "Usage: /diplomacy reply target:<chat id> message:<text>", ephemeral: true });
      await interaction.deferReply();
      const r = await oh("postChatReply", chatId, message);
      return interaction.editReply(`Reply sent as **${nation}**. ${r?.messages?.length ? `The other side answered.` : ""}`);
    }
    if (action === "open") {
      const target = interaction.options.getString("target");
      if (!target || !message) return interaction.reply({ content: "Usage: /diplomacy open target:<nation> message:<text>", ephemeral: true });
      await interaction.deferReply();
      await oh("queueActionFor", nation, `Open diplomatic talks with ${target}: ${message}`);
      return interaction.editReply(`Queued an outreach to **${target}** — it resolves on the next jump.`);
    }
  }

  if (name === "inspect") {
    await interaction.deferReply();
    const r = await oh("inspectRegion", { name: interaction.options.getString("region", true) });
    return interaction.editReply(r?.regionId ? `**${r.name || interaction.options.getString("region")}** — owner: ${r.owner || "unclaimed"}${r.loadedOnMap ? "" : " (not in the current view)"}` : "No such region found.");
  }
  if (name === "country") {
    await interaction.deferReply();
    try { const sheet = await oh("countryStatSheet", { name: interaction.options.getString("name", true) }); return interaction.editReply({ embeds: [embed(`📊 ${interaction.options.getString("name")}`, "```json\n" + JSON.stringify(sheet, null, 2).slice(0, 3500) + "\n```")] }); }
    catch (e) { return interaction.editReply(`Couldn't fetch that: ${e.message}`); }
  }
  if (name === "map") { await interaction.deferReply(); await postMap(game, interaction.options.getString("focus"), interaction.channelId); return interaction.editReply("🗺️ Posted above."); }
  if (name === "live") { const u = liveUrl(); return interaction.reply(u ? `🔴 Live read-only map: ${u}` : "The tunnel isn't up yet — try again shortly."); }
  if (name === "status") {
    const nations = isMulti(game) ? game.factions.map((f) => f.nation).join(", ") : game.primaryNation;
    return interaction.reply({ embeds: [embed("Status", [`Nations: **${nations}**`, `Round: **${game.round + 1}**`, `Phase: **${game.phase}**`, `Proposals: **${Object.values(game.ballots).flatMap((b) => b.options).length}**`].join("\n"))] });
  }
  if (name === "endgame") {
    if (!isHost(interaction)) return interaction.reply({ content: "Only a host can end the game.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    clearTimeout(timers.get(gid));
    const ending = store.getGame(gid);
    // Tear down everything this game created: the per-nation war-rooms, #oh-world,
    // and the faction roles. Deleting the channel the command ran in is fine — the
    // reply goes back through the interaction token, not that channel.
    let removedChannels = 0;
    const channelIds = [...(ending.factions || []).map((f) => f.channelId), ending.worldChannelId].filter(Boolean);
    for (const id of channelIds) {
      try { const ch = await client.channels.fetch(id); if (ch) { await ch.delete("Open Historia game ended"); removedChannels += 1; } }
      catch { /* already deleted — fine */ }
    }
    let removedRoles = 0;
    for (const f of ending.factions || []) {
      try { const role = await interaction.guild.roles.fetch(f.roleId); if (role) { await role.delete("Open Historia game ended"); removedRoles += 1; } }
      catch { /* already deleted — fine */ }
    }
    store.resetGame(gid);
    try {
      await interaction.editReply(`🏁 Game ended. Removed ${removedChannels} war-room/world channel(s)${removedRoles ? ` and ${removedRoles} faction role(s)` : ""}. Thanks for playing!`);
    } catch { /* the channel we replied in was one of the deleted ones */ }
    return;
  }
}

client.once("ready", async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.warn("command registration failed:", e.message); }
  try { await waitForBridge(); console.log("bridge ready — the bot can drive the game."); } catch (e) { console.warn(e.message); }
  await reconcile();
});

await registerCommands().catch(() => {});
await client.login(token);
