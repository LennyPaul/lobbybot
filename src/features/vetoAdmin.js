// src/features/vetoAdmin.js
import { col } from "../db/models.js";
import {
  updateRecapForVeto,
  handleVetoConfig as vetoHandleVetoConfig,
  handleVetoShowConfig as vetoHandleVetoShowConfig,
} from "./veto.js";
import { requireRole } from "../lib/roles.js";

/**
 * /veto_config (admin)
 * Applique la configuration du veto (capitaines, maps, durée de tour).
 * -> Contrôle rôles avant d'appeler le handler d'origine (veto.js)
 */
export async function handleVetoConfig(interaction, client) {
  if (!(await requireRole(interaction, "veto_config"))) return;

  try {
    await vetoHandleVetoConfig(interaction, client);
  } catch (e) {
    try { await interaction.reply({ content: `Erreur: ${e.message}`, ephemeral: true }); } catch {}
  }
}

/**
 * /veto_show_config (admin)
 * Affiche la configuration actuelle du veto.
 * -> Contrôle rôles avant d'appeler le handler d'origine (veto.js)
 */
export async function handleVetoShowConfig(interaction) {
  if (!(await requireRole(interaction, "veto_show_config"))) return;

  try {
    await vetoHandleVetoShowConfig(interaction);
  } catch (e) {
    try { await interaction.reply({ content: `Erreur: ${e.message}`, ephemeral: true }); } catch {}
  }
}

/**
 * /veto_set_captain (admin)
 * - Change le capitaine d’une équipe (A ou B) pour un match donné
 * - Met à jour le message récap (#1) dans le thread
 * - Réponse admin en éphémère
 */
export async function handleVetoSetCaptain(interaction, client) {
  if (!(await requireRole(interaction, "veto_set_captain"))) return;

  const matchId = interaction.options.getInteger("match_id", true);
  const team = interaction.options.getString("team", true); // "A" | "B"
  const user = interaction.options.getUser("user", true);
  const userId = user.id;

  const state = await col("veto").findOne({ matchId });
  if (!state) {
    return interaction.reply({
      content: `Aucun veto trouvé pour le match #${matchId}.`,
      ephemeral: true,
    });
  }

  const teamIds = team === "A" ? (state.teamA || []) : (state.teamB || []);
  if (!teamIds.includes(userId)) {
    return interaction.reply({
      content: `Le joueur sélectionné n'appartient pas à l'équipe **${team}** de ce match.`,
      ephemeral: true,
    });
  }

  const update = team === "A" ? { captainA: userId } : { captainB: userId };
  await col("veto").updateOne(
    { matchId },
    { $set: { ...update, updatedAt: new Date() } }
  );

  await updateRecapForVeto(client, matchId).catch(() => {});

  return interaction.reply({
    content: `Capitaine de l'équipe **${team}** mis à jour : <@${userId}> (match #${matchId}).`,
    ephemeral: true,
  });
}
