/*! Open Historia — Discord edition: factions (roles + war-rooms). © 2026 Nicholas Krol, MIT. */
// Provisions a Discord role + private war-room text channel per nation, plus one
// shared read-only #oh-world channel. Each faction's players propose and vote in
// their own war-room; results and the live map post to #oh-world. Requires the
// bot to have Manage Roles + Manage Channels (and the Server Members privileged
// intent so it can assign roles by member).
import { ChannelType, PermissionFlagsBits } from "discord.js";
import * as store from "./persistence.mjs";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

// Create #oh-world (everyone can read, only the bot posts) + one role + private
// war-room per nation. Idempotent-ish: reuses a same-named role/channel if found.
export async function provisionFactions(guild, nations) {
  // The bot's own id — from the client user, so we don't depend on the member
  // cache (which needs the privileged Server Members intent we deliberately omit).
  const meId = guild.client.user.id;
  const everyone = guild.roles.everyone;
  const factions = [];

  // Shared world feed — read-only for @everyone.
  let world = guild.channels.cache.find((c) => c.name === "oh-world" && c.type === ChannelType.GuildText);
  if (!world) {
    world = await guild.channels.create({
      name: "oh-world",
      type: ChannelType.GuildText,
      topic: "Open Historia — world events + live map (read-only)",
      permissionOverwrites: [
        { id: everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] },
        { id: meId, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AttachFiles] },
      ],
    });
  }

  for (const nation of nations) {
    const roleName = `OH ${nation}`;
    let role = guild.roles.cache.find((r) => r.name === roleName) || (await guild.roles.create({ name: roleName, mentionable: true }));
    const chName = `${slug(nation)}-war-room`;
    let channel = guild.channels.cache.find((c) => c.name === chName && c.type === ChannelType.GuildText);
    if (!channel) {
      channel = await guild.channels.create({
        name: chName,
        type: ChannelType.GuildText,
        topic: `${nation} war room — propose and vote on ${nation}'s moves`,
        permissionOverwrites: [
          { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: meId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
        ],
      });
    }
    factions.push({ nation, roleId: role.id, channelId: channel.id });
  }
  return { worldChannelId: world.id, factions };
}

// Give a member the nation's role (and drop any other OH faction role).
export async function assignNation(guild, member, nation) {
  const game = store.getGame(guild.id);
  const target = game.factions?.find((f) => f.nation.toLowerCase() === nation.toLowerCase());
  if (!target) throw new Error(`No faction named "${nation}" in this game.`);
  const otherRoleIds = (game.factions || []).map((f) => f.roleId).filter((id) => id !== target.roleId);
  await member.roles.remove(otherRoleIds.filter((id) => member.roles.cache.has(id))).catch(() => {});
  await member.roles.add(target.roleId);
  store.setPlayerNation(guild.id, member.id, target.nation);
  return target.nation;
}

// Which nation owns a given channel (a war-room), if any.
export const nationForChannel = (game, channelId) =>
  (game.factions || []).find((f) => f.channelId === channelId)?.nation || null;
