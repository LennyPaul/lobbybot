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

    // 🔒 Bloque l'annulation si le veto est en cours (il reste >1 map et un tour actif)
  const veto = await col("veto").findOne(
    { matchId },
    { projection: { currentTeam: 1, remaining: 1 } }
  );
  if (veto && veto.currentTeam && Array.isArray(veto.remaining) && veto.remaining.length > 1) {
    return interaction.reply({
      content: `⛔ Impossible d’annuler le match #${matchId} tant que le **veto** est en cours. Attendez la fin du ban de cartes.`,
      ephemeral: true,
    });
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
