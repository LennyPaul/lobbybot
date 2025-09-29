// src/features/boards.js
import { ChannelType, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { col } from "../db/models.js";
import { requireRole } from "../lib/roles.js";

/** ========= helpers channels ========= **/
async function ensureTextChannel(guild, name) {
  let ch = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText);
  if (!ch) {
    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error(`Permissions insuffisantes pour créer #${name}`);
    }
    ch = await guild.channels.create({ name, type: ChannelType.GuildText, reason: `Création automatique du salon ${name}` });
  }
  return ch;
}
function chunkArray(arr, size) { const out = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }

/** ========= LEADERBOARD ========= **/
export async function refreshLeaderboard(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const ch = await ensureTextChannel(guild, "📊┃leaderboard");

  const winsAgg = await col("match_players").aggregate([
    { $lookup: { from: "matches", localField: "matchId", foreignField: "matchId", as: "m" } },
    { $unwind: "$m" },
    { $match: { "m.status": "closed" } },
    { $group: { _id: "$userId", games: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ["$team", "$m.winner"] }, 1, 0] } } } }
  ]).toArray();

  const statsByUser = new Map(winsAgg.map(x => [x._id, x]));
  const players = await col("players").find().project({ userId: 1, rating: 1 }).toArray();

  const rows = players.map(p => {
    const s = statsByUser.get(p.userId);
    const games = s?.games ?? 0;
    const wins = s?.wins ?? 0;
    const wr = games > 0 ? Math.round((wins / games) * 100) : 0;
    return { userId: p.userId, rating: p.rating ?? 100, games, wins, wr };
  });

  rows.sort((a, b) => (b.rating - a.rating) || (b.wr - a.wr));

  const pageSize = 30;
  const pages = chunkArray(rows, pageSize);

  const embeds = pages.map((slice, idx) => {
    const lines = slice.map((r, i) =>
      `**${idx * pageSize + i + 1}.** <@${r.userId}> — Elo **${r.rating}** · WR **${r.wr}%** (${r.wins}/${r.games})`
    ).join("\n");
    return new EmbedBuilder()
      .setTitle(`Leaderboard — Page ${idx + 1}/${pages.length || 1}`)
      .setDescription(lines || "_Aucun joueur_");
  });

  const cfg = await col("config").findOne({ _id: "leaderboard" }) || {};
  const existingIds = Array.isArray(cfg.messageIds) ? cfg.messageIds : [];
  const newIds = [];

  for (let i = 0; i < embeds.length; i++) {
    const eb = embeds[i];
    const existingId = existingIds[i];
    if (existingId) {
      try {
        const msg = await ch.messages.fetch(existingId);
        await msg.edit({ embeds: [eb] });
        newIds.push(existingId);
        continue;
      } catch {}
    }
    const sent = await ch.send({ embeds: [eb] });
    newIds.push(sent.id);
  }

  if (existingIds.length > newIds.length) {
    const toDelete = existingIds.slice(newIds.length);
    for (const id of toDelete) {
      try { const msg = await ch.messages.fetch(id); await msg.delete(); } catch {}
    }
  }

  if (embeds.length === 0) {
    for (const id of existingIds) {
      try { const msg = await ch.messages.fetch(id); await msg.delete(); } catch {}
    }
    const empty = new EmbedBuilder().setTitle("Leaderboard").setDescription("_Aucun joueur_");
    const sent = await ch.send({ embeds: [empty] });
    newIds.push(sent.id);
  }

  await col("config").updateOne(
    { _id: "leaderboard" },
    { $set: { channelId: ch.id, messageIds: newIds, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function handleSetupLeaderboard(interaction, client) {
  if (!(await requireRole(interaction, "setup_leaderboard"))) return;

  let deferred = false;
  try { await interaction.deferReply({ ephemeral: true }); deferred = true; } catch {}
  try {
    await refreshLeaderboard(client, interaction.guildId);
    const ok = "Leaderboard prêt ✅";
    if (deferred) { try { await interaction.editReply({ content: ok }); } catch {} }
    else { try { await interaction.reply({ content: ok, ephemeral: true }); } catch {} }
  } catch (e) {
    const msg = `Erreur: ${e.message}`;
    if (deferred) { try { await interaction.editReply({ content: msg }); } catch {} }
    else { try { await interaction.reply({ content: msg, ephemeral: true }); } catch {} }
  }
}

/** ========= MATCH HISTORY ========= **/
function statusLabel(m) {
  if (m.status === "voting") return "En cours";
  if (m.status === "closed") return "Terminé";
  if (m.status === "reversed") return "Annulé";
  if (m.status === "abandoned") return "Abandonné";
  if (m.status === "review") return "Review Admin";
  return m.status || "Inconnu";
}

async function buildMatchHistoryEmbed(matchId) {
  const match = await col("matches").findOne({ matchId });
  if (!match) return new EmbedBuilder().setTitle(`Match #${matchId}`).setDescription("_Inconnu_");

  const players = await col("match_players").find({ matchId }).toArray();
  const teamA = players.filter(p => p.team === "A").map(p => `<@${p.userId}>`);
  const teamB = players.filter(p => p.team === "B").map(p => `<@${p.userId}>`);

  const veto = await col("veto").findOne({ matchId });
  const capA = veto?.captainA ? `<@${veto.captainA}>` : "—";
  const capB = veto?.captainB ? `<@${veto.captainB}>` : "—";
  const picked = veto?.picked ? `\`${veto.picked}\`` : "—";

  const winner = match.winner ? (match.winner === "A" ? "Équipe A" : "Équipe B") : "—";

  return new EmbedBuilder()
    .setTitle(`Match #${matchId} — ${statusLabel(match)}`)
    .setDescription(
      `**Capitaines**: A → ${capA} | B → ${capB}\n` +
      `**Map**: ${picked}\n` +
      `**Gagnant**: ${winner}`
    )
    .addFields(
      { name: "Équipe A", value: teamA.join("\n") || "—", inline: true },
      { name: "Équipe B", value: teamB.join("\n") || "—", inline: true },
    )
    .setFooter({ text: match.createdAt ? `Créé le ${new Date(match.createdAt).toLocaleString()}` : "" });
}

export async function upsertMatchHistoryMessage(client, guildId, matchId) {
  const guild = await client.guilds.fetch(guildId);
  const ch = await ensureTextChannel(guild, "🎮┃match-history");
  const eb = await buildMatchHistoryEmbed(matchId);
  const match = await col("matches").findOne({ matchId });
  if (!match) return;

  if (match.historyChannelId && match.historyMessageId) {
    try {
      const historyCh = await client.channels.fetch(match.historyChannelId);
      const msg = await historyCh.messages.fetch(match.historyMessageId);
      await msg.edit({ embeds: [eb] });
      return;
    } catch { /* recreate */ }
  }

  const sent = await ch.send({ embeds: [eb] });
  await col("matches").updateOne(
    { matchId },
    { $set: { historyChannelId: ch.id, historyMessageId: sent.id, updatedAt: new Date() } }
  );
}

export async function resetMatchHistoryBoard(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const ch = await ensureTextChannel(guild, "🎮┃match-history");
  try {
    let lastId = undefined;
    for (let round = 0; round < 10; round++) {
      const msgs = await ch.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
      if (!msgs || msgs.size === 0) break;
      for (const m of msgs.values()) {
        if (m.author?.id === client.user.id) { try { await m.delete(); } catch {} }
        lastId = m.id;
      }
      if (msgs.size < 100) break;
    }
  } catch { /* ignore */ }
}

export async function handleSetupMatchHistory(interaction, client) {
  if (!(await requireRole(interaction, "setup_match_history"))) return;

  let deferred = false;
  try { await interaction.deferReply({ ephemeral: true }); deferred = true; } catch {}
  try {
    const guild = await interaction.guild.fetch();
    await ensureTextChannel(guild, "🎮┃match-history");
    const all = await col("matches").find().project({ matchId: 1 }).sort({ matchId: 1 }).toArray();
    for (const m of all) {
      // eslint-disable-next-line no-await-in-loop
      await upsertMatchHistoryMessage(client, interaction.guildId, m.matchId);
    }
    const ok = "Match history initialisé ✅";
    if (deferred) { try { await interaction.editReply({ content: ok }); } catch {} }
    else { try { await interaction.reply({ content: ok, ephemeral: true }); } catch {} }
  } catch (e) {
    const msg = `Erreur: ${e.message}`;
    if (deferred) { try { await interaction.editReply({ content: msg }); } catch {} }
    else { try { await interaction.reply({ content: msg, ephemeral: true }); } catch {} }
  }
}
