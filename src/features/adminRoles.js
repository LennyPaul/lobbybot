// src/features/adminRoles.js
import { col } from "../db/models.js";
import { EmbedBuilder } from "discord.js";

/** /admin_roles_set : définit les rôles autorisés pour une commande */
export async function handleAdminRolesSet(interaction) {
  // On autorise seulement les admins Discord à modifier la config
  if (!interaction.memberPermissions?.has("Administrator")) {
    return interaction.reply({ content: "⛔ Seuls les administrateurs peuvent modifier les rôles.", ephemeral: true });
  }

  const command = interaction.options.getString("command", true).trim().toLowerCase();
  const roles = [];
  for (let i = 1; i <= 5; i++) {
    const r = interaction.options.getRole(`role${i}`);
    if (r) roles.push(r.id);
  }

  await col("config").updateOne(
    { _id: `roles:${command}` },
    { $set: { roleIds: roles, updatedAt: new Date() } },
    { upsert: true }
  );

  const names = roles.map(id => `<@&${id}>`).join(", ") || "_(aucun — fallback Admin)_";
  return interaction.reply({
    content: `✅ Rôles autorisés pour **${command}** mis à jour : ${names}`,
    ephemeral: true,
  });
}

/** /admin_roles_show : affiche la configuration actuelle */
export async function handleAdminRolesShow(interaction) {
  if (!interaction.memberPermissions?.has("Administrator")) {
    return interaction.reply({ content: "⛔ Seuls les administrateurs peuvent consulter cette configuration.", ephemeral: true });
  }

  // On liste seulement les commandes qu’on gère ici (tu peux en ajouter si besoin)
  const commandNames = [
    "setup",
    "fill",
    "clearqueue",
    "veto_config",
    "veto_show_config",
    "veto_set_captain",
    "forcewin",
    "match_reverse",
    "match_cancel",
    "match_set_winner",
    "setup_leaderboard",
    "setup_match_history",
  ];

  const docs = await col("config").find({ _id: { $in: commandNames.map(n => `roles:${n}`) } }).toArray();
  const byId = new Map(docs.map(d => [d._id.replace("roles:", ""), d.roleIds || []]));

  const eb = new EmbedBuilder()
    .setTitle("Rôles autorisés par commande")
    .setDescription("Si aucun rôle n’est défini pour une commande ➜ fallback **Administrateur** requis.");

  for (const name of commandNames) {
    const ids = byId.get(name) || [];
    const value = ids.length ? ids.map(id => `<@&${id}>`).join(", ") : "_(fallback Admin)_";
    eb.addFields({ name, value, inline: true });
  }

  return interaction.reply({ embeds: [eb], ephemeral: true });
}
