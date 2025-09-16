// src/features/adminRoles.js
import { col } from "../db/models.js";
import { EmbedBuilder } from "discord.js";

export const ALL_ROLE_KEYS = [
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
  "admin_roles_set",
  "admin_roles_show",
  "admin_roles_keys",
  "admin_review_pick",
  "wipe_players",
];

export async function handleAdminRolesKeys(interaction) {
  // Récupère toutes les config existantes pour croiser
  const docs = await col("config")
    .find({ _id: { $regex: /^roles:/ } })
    .project({ _id: 1, roleIds: 1 })
    .toArray();
  const map = new Map(docs.map(d => [d._id.replace(/^roles:/, ""), (Array.isArray(d.roleIds) ? d.roleIds.filter(Boolean) : [])]));

  const lines = ALL_ROLE_KEYS.map(key => {
    const roles = map.get(key) || [];
    const text = roles.length ? roles.map(r => `<@&${r}>`).join(", ") : "— (fallback **Administrateur**)";
    return `• **${key}** → ${text}`;
  });

  return interaction.reply({
    content:
      `**Autorisations disponibles (toutes les clés)**\n` +
      lines.join("\n") +
      `\n\nUtilise \`/admin_roles_set\` pour modifier une clé.`,
    ephemeral: true,
  });
}

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
const key = interaction.options.getString("key"); // optionnel

 // Si une clé est fournie → affichage simple (comportement ancien)
 if (key) {
  const doc = await col("config").findOne({ _id: `roles:${key}` });
   const roleIds = Array.isArray(doc?.roleIds) ? doc.roleIds.filter(Boolean) : [];
    const list = roleIds.length
      ? roleIds.map(rid => `<@&${rid}>`).join(", ")
      : "— (aucun, fallback = **Administrateur** serveur)";
    return interaction.reply({
      content: `Rôles autorisés pour **${key}** : ${list}`,
      ephemeral: true,
    });
  }

  // Sinon → récapitulatif de TOUTES les autorisations connues
  const docs = await col("config")
    .find({ _id: { $regex: /^roles:/ } })
    .project({ _id: 1, roleIds: 1 })
    .toArray();

  if (!docs.length) {
    return interaction.reply({
      content: "Aucune autorisation spécifique enregistrée. Toutes les commandes protégées **tombent en fallback Administrateur**.",
      ephemeral: true,
    });
  }

  // Tri alpha par key pour lisibilité
  docs.sort((a, b) => a._id.localeCompare(b._id));

  // Construit un petit texte propre (une ligne par clé)
  const lines = docs.map(d => {
    const keyName = d._id.replace(/^roles:/, "");
    const ids = Array.isArray(d.roleIds) ? d.roleIds.filter(Boolean) : [];
    const render = ids.length ? ids.map(r => `<@&${r}>`).join(", ") : "— (fallback **Administrateur**)";
    return `• **${keyName}** → ${render}`;
  });

  return interaction.reply({
    content:
      `**Autorisations (récapitulatif)**\n` +
      lines.join("\n"),
    ephemeral: true,
  });
}
