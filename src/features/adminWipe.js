// src/features/adminWipe.js
import { col } from "../db/models.js";
import { refreshQueuePanel } from "./queuePanel.js";
import { refreshLeaderboard, resetMatchHistoryBoard } from "./boards.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { requireAdminKey } from "../lib/auth.js";

// Trouve/crée #logs-bot
async function getLogsChannel(guild) {
  if (!guild) return null;
  const name = "logs-bot";

  let ch = guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildText
  );
  if (ch) return ch;

  try {
    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return null;
    ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      reason: "Salon de logs du bot",
    });
    return ch;
  } catch {
    return null;
  }
}

/**
 * /wipe_players confirm:true key:<ADMIN_KEY>
 * - Supprime TOUTES les données liées aux joueurs (players, queue, matches, votes, rating_history, veto…)
 * - Conserve les configs (config collection)
 * - Met à jour #leaderboard, #match-history et le panneau de queue
 * - Log dans #logs-bot
 * - Commande protégée par mot de passe (.env ADMIN_KEY)
 */
export async function handleWipePlayers(interaction, client) {
  // 🔐 Vérification du mot de passe
  if (!(await requireAdminKey(interaction))) return;

  const confirm = interaction.options.getBoolean("confirm", true);
  if (!confirm) {
    return interaction.reply({
      content: "Action annulée : passe `confirm: true` pour confirmer la purge.",
      ephemeral: true,
    });
  }

  let deferred = false;
  try {
    await interaction.deferReply({ ephemeral: true });
    deferred = true;
  } catch {}

  try {
    // On purge toutes les collections "données joueurs"
    const ops = [
      col("players").deleteMany({}),
      col("queue").deleteMany({}),
      col("matches").deleteMany({}),
      col("match_players").deleteMany({}),
      col("votes").deleteMany({}),
      col("rating_history").deleteMany({}),
      col("veto").deleteMany({}),
    ];
    await Promise.all(ops);

    // UI : rafraîchir panneaux/boards
    try { await refreshQueuePanel(client); } catch {}
    try { await refreshLeaderboard(client, interaction.guildId); } catch {}
    try { await resetMatchHistoryBoard(client, interaction.guildId); } catch {}

    // Logs
    try {
      const logs = await getLogsChannel(interaction.guild);
      if (logs) {
        await logs.send(`🧹 **/wipe_players** — purge complète exécutée par <@${interaction.user.id}>. (Configs conservées)`);
      }
    } catch {}

    const msg = "Purge terminée ✅ — données joueurs supprimées, configs conservées, salons mis à jour.";
    if (deferred) {
      try { await interaction.editReply({ content: msg }); } catch {}
    } else {
      try { await interaction.reply({ content: msg, ephemeral: true }); } catch {}
    }
  } catch (e) {
    const err = `Erreur pendant la purge: ${e.message}`;
    if (deferred) {
      try { await interaction.editReply({ content: err }); } catch {}
    } else {
      try { await interaction.reply({ content: err, ephemeral: true }); } catch {}
    }
  }
}
