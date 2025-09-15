// src/features/adminForce.js
import { col } from "../db/models.js";
import { finalizeMatch } from "./matchFlow.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { upsertMatchHistoryMessage } from "./boards.js";

// Helper local : trouver/créer #logs-bot
async function getLogsChannel(guild) {
  if (!guild) return null;
  const name = "logs-bot";
  let ch = guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildText
  );
  if (!ch) {
    try {
      if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return null;
      }
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        reason: "Salon de logs du bot",
      });
    } catch {
      return null;
    }
  }
  return ch;
}

export async function handleForceWin(interaction, client) {
  const matchId = interaction.options.getInteger("match_id", true);
  const team = interaction.options.getString("team", true); // "A" ou "B"

  const match = await col("matches").findOne({ matchId });
  if (!match) {
    return interaction.reply({ content: `Match #${matchId} introuvable.`, ephemeral: true });
  }
  if (match.status === "closed") {
    return interaction.reply({ content: `Match #${matchId} déjà clôturé (vainqueur: ${match.winner ?? "?"}).`, ephemeral: true });
  }

  // On ne montre rien à l’admin en succès : on log simplement
  try { await interaction.deferReply({ ephemeral: true }); } catch {}

  try {
    // S'assurer que l’entrée match-history existe en “En cours”
    try { await upsertMatchHistoryMessage(client, interaction.guildId, matchId); } catch {}

    // Puis on clôture avec le gagnant forcé
    await finalizeMatch(matchId, team, client);

    // Log dans #logs-bot
    try {
      const guild = interaction.guild ?? (await client.guilds.fetch(interaction.guildId));
      const logs = await getLogsChannel(guild);
      if (logs) {
        await logs.send(`🛠️ **/forcewin** — Match #${matchId} → Victoire forcée **${team}** par <@${interaction.user.id}>`);
      }
    } catch {}

    // Supprime la réponse éphémère pour ne rien laisser à l’admin
    try { await interaction.deleteReply(); } catch {}
  } catch (e) {
    // En cas d’erreur : petit message éphémère + log
    try { await interaction.editReply({ content: "Erreur lors du forçage de la victoire." }); } catch {}
    try {
      const guild = interaction.guild ?? (await client.guilds.fetch(interaction.guildId));
      const logs = await getLogsChannel(guild);
      if (logs) {
        await logs.send(`❌ **/forcewin** — Match #${matchId} a échoué : \`${e?.message}\``);
      }
    } catch {}
  }
}
