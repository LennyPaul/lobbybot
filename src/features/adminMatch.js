// src/features/adminMatch.js
import { col } from "../db/models.js";
import { finalizeMatch } from "./matchFlow.js";
import { refreshLeaderboard, upsertMatchHistoryMessage } from "./boards.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { requireRole } from "../lib/roles.js";

// Helper local : trouver/créer #logs-bot
async function getLogsChannel(guild) {
  if (!guild) return null;
  const name = "logs-bot";
  let ch = guild.channels.cache.find((c) => c.name === name && c.type === ChannelType.GuildText);
  if (!ch) {
    try {
      if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return null;
      ch = await guild.channels.create({ name, type: ChannelType.GuildText, reason: "Salon de logs du bot" });
    } catch { return null; }
  }
  return ch;
}

async function reverseMatchElo(matchId) {
  const history = await col("rating_history").find({ matchId, reverted: { $ne: true } }).toArray();
  if (!history.length) throw new Error("Aucun historique d’Elo actif pour ce match.");
  const bulk = col("players").initializeUnorderedBulkOp();
  for (const h of history) {
    bulk.find({ userId: h.userId }).updateOne({ $inc: { rating: -h.delta, gamesPlayed: -1 }, $set: { updatedAt: new Date() } });
  }
  if (bulk.length) await bulk.execute();
  await col("rating_history").updateMany({ matchId }, { $set: { reverted: true, revertedAt: new Date() } });
}

export async function handleMatchReverse(interaction, client) {
  if (!(await requireRole(interaction, "match_reverse"))) return;

  const matchId = interaction.options.getInteger("match_id", true);
  try { await interaction.deferReply({ ephemeral: true }); } catch {}

  const match = await col("matches").findOne({ matchId });
  if (!match) return interaction.editReply({ content: `Match #${matchId} introuvable.` });
  if (match.status !== "closed") return interaction.editReply({ content: `Match #${matchId} n’est pas terminé.` });

  try {
    await reverseMatchElo(matchId);
    await col("matches").updateOne({ matchId }, { $set: { status: "reversed", reversedAt: new Date(), previousWinner: match.winner, winner: null } });

    let guildId = null;
    try { guildId = (await client.channels.fetch(match.threadId))?.guildId; } catch {}
    if (guildId) {
      await refreshLeaderboard(client, guildId);
      await upsertMatchHistoryMessage(client, guildId, matchId);
    }

    try {
      const logs = await getLogsChannel(interaction.guild);
      if (logs) await logs.send(`♻️ **/match_reverse** — Match #${matchId} annulé par <@${interaction.user.id}>. Elo restauré.`);
    } catch {}

    try { await interaction.deleteReply(); } catch {}
  } catch (e) {
    try { await interaction.editReply({ content: `Erreur: ${e.message}` }); } catch {}
  }
}

export async function handleMatchCancel(interaction, client) {
  if (!(await requireRole(interaction, "match_cancel"))) return;

  const matchId = interaction.options.getInteger("match_id", true);
  try { await interaction.deferReply({ ephemeral: true }); } catch {}

  const match = await col("matches").findOne({ matchId });
  if (!match) return interaction.editReply({ content: `Match #${matchId} introuvable.` });
  if (match.status === "closed") return interaction.editReply({ content: `Match #${matchId} est déjà terminé.` });
  if (match.status === "abandoned") return interaction.editReply({ content: `Match #${matchId} est déjà abandonné.` });

  try {
    await col("matches").updateOne({ matchId }, { $set: { status: "abandoned", canceledAt: new Date() } });

    if (match.threadId) {
      try {
        const thread = await client.channels.fetch(match.threadId);
        if (thread && !thread.archived) await thread.setArchived(true, "Match abandonné");
      } catch {}
    }

    let guildId = null;
    try { guildId = (await client.channels.fetch(match.threadId))?.guildId; } catch {}
    if (guildId) await upsertMatchHistoryMessage(client, guildId, matchId);

    try {
      const logs = await getLogsChannel(interaction.guild);
      if (logs) await logs.send(`🛑 **/match_cancel** — Match #${matchId} abandonné par <@${interaction.user.id}>.`);
    } catch {}

    try { await interaction.deleteReply(); } catch {}
  } catch (e) {
    try { await interaction.editReply({ content: `Erreur: ${e.message}` }); } catch {}
  }
}

export async function handleMatchSetWinner(interaction, client) {
  if (!(await requireRole(interaction, "match_set_winner"))) return;

  const matchId = interaction.options.getInteger("match_id", true);
  const team = interaction.options.getString("team", true);
  try { await interaction.deferReply({ ephemeral: true }); } catch {}

  const match = await col("matches").findOne({ matchId });
  if (!match) return interaction.editReply({ content: `Match #${matchId} introuvable.` });
  if (team !== "A" && team !== "B") return interaction.editReply({ content: "Team invalide (A/B)." });
  if (match.status !== "closed") {
    return interaction.editReply({ content: "Cette commande ne s’utilise que sur un match déjà terminé." });
  }

  try {
    await reverseMatchElo(matchId);
    await col("matches").updateOne({ matchId }, { $set: { status: "voting", winner: null } });

    try { await upsertMatchHistoryMessage(client, interaction.guildId, matchId); } catch {}
    await finalizeMatch(matchId, team, client);
    await col("matches").updateOne({ matchId }, { $set: { adminSetWinnerId: interaction.user.id } });

    let guildId = null;
    try { guildId = (await client.channels.fetch(match.threadId))?.guildId; } catch {}
    if (guildId) {
      await refreshLeaderboard(client, guildId);
      await upsertMatchHistoryMessage(client, guildId, matchId);
    }

    try {
      const logs = await getLogsChannel(interaction.guild);
      if (logs) await logs.send(`✏️ **/match_set_winner** — Match #${matchId} → gagnant **${team}** par <@${interaction.user.id}>.`);
    } catch {}

    try { await interaction.deleteReply(); } catch {}
  } catch (e) {
    try { await interaction.editReply({ content: `Erreur: ${e.message}` }); } catch {}
  }
}
