// src/lib/roles.js
import { PermissionFlagsBits } from "discord.js";
import { col } from "../db/models.js";

/**
 * Vérifie si l'utilisateur a le droit d'utiliser une commande "admin" donnée.
 * - On cherche un doc config: { _id: `roles:<commandName>`, roleIds: [..] }
 * - Si pas défini ou vide => fallback: doit avoir permission ADMINISTRATOR.
 * - Si défini => l'utilisateur doit posséder AU MOINS un des rôles listés.
 * Retourne true si autorisé, sinon envoie un message éphémère et retourne false.
 */
export async function requireRole(interaction, commandName) {
  // Garbage guard
  if (!interaction?.member) {
    try { await interaction.reply({ content: "Commande indisponible ici.", ephemeral: true }); } catch {}
    return false;
  }

  const doc = await col("config").findOne({ _id: `roles:${commandName}` });
  const allow = Array.isArray(doc?.roleIds) ? doc.roleIds.filter(Boolean) : [];

  // Fallback => ADMIN only
  if (allow.length === 0) {
    const isAdmin = interaction.member.permissions?.has?.(PermissionFlagsBits.Administrator);
    if (isAdmin) return true;
    try {
      await interaction.reply({
        content: "⛔ Tu n’as pas la permission d’utiliser cette commande (Admin requis).",
        ephemeral: true,
      });
    } catch {}
    return false;
  }

  // Liste blanche => doit avoir au moins un des rôles
  const memberRoleIds = interaction.member.roles?.cache?.map(r => r.id) ?? [];
  const ok = allow.some(rid => memberRoleIds.includes(rid));
  if (ok) return true;

  try {
    await interaction.reply({
      content: "⛔ Tu n’as pas la permission d’utiliser cette commande (rôle requis).",
      ephemeral: true,
    });
  } catch {}
  return false;
}
