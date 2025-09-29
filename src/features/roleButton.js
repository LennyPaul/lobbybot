// src/features/roleButton.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";

/* =========================
   Helpers
   ========================= */

/** Découpe un long texte en morceaux de taille max (pour les embeds). */
function splitIntoChunks(text, size = 4000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [text];
}

/** Récupère le texte depuis l’option "text" ou un attachment .txt */
async function resolveRulesText(interaction) {
  const txt = interaction.options.getString("text");
  const att = interaction.options.getAttachment("attachment");
  if (att) {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Impossible de lire la pièce jointe (HTTP ${res.status}).`);
    return (await res.text()).trim();
  }
  if (typeof txt === "string" && txt.trim().length) return txt.trim();
  throw new Error("Aucun texte fourni. Utilise l’option `text` ou joins un fichier `.txt`.");
}

/** Vérifie si le bot peut gérer (hiérarchiquement) un rôle donné. */
function canManageRole(meMember, role) {
  if (!role) return false;
  const myTop = meMember?.roles?.highest?.position ?? 0;
  return myTop > role.position;
}

/* =========================
   Commande: /rules_panel
   - Publie le règlement (1..N embeds)
   - Ajoute un bouton qui:
       • ajoute role_add (si fourni)
       • retire role_remove (si fourni)
   - CustomId: "accept_roles:<addId|0>:<remId|0>"
   ========================= */
export async function handleRulesPanelCommand(interaction) {
  const addRole = interaction.options.getRole("role_add");
  const removeRole = interaction.options.getRole("role_remove");
  const place = interaction.options.getString("button_place") || "first";
  const chosenChannel = interaction.options.getChannel("channel");
  const channel =
    (chosenChannel && chosenChannel.type === ChannelType.GuildText)
      ? chosenChannel
      : interaction.channel;

  if (!addRole && !removeRole) {
    return interaction.reply({
      content: "Tu dois fournir **role_add** et/ou **role_remove**.",
      ephemeral: true,
    });
  }

  // Permissions basiques dans le salon cible
  const me = interaction.guild.members.me;
  const perms = me?.permissionsIn(channel);
  if (!perms?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: "⛔ Le bot ne peut pas envoyer de messages ici.", ephemeral: true });
  }
  if (!perms?.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: "⛔ Il manque la permission **Intégrer des liens** (Embed Links).", ephemeral: true });
  }

  // Lire/produire le texte
  let fullText;
  try { fullText = await resolveRulesText(interaction); }
  catch (e) { return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true }); }

  const chunks = splitIntoChunks(fullText, 4000);
  const embeds = chunks.map((c, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? "📜 Règlement" : `📜 Suite (${i + 1})`)
      .setDescription(c)
  );

  // Construire le bouton double action
  const addId = addRole?.id ?? "0";
  const remId = removeRole?.id ?? "0";

  let label = "Accepter";
  if (addRole && removeRole) label = `Accepter le règlement des matchs`;
  else if (addRole) label = `✅ Obtenir @${addRole.name}`;
  else if (removeRole) label = `❌ Retirer @${removeRole.name}`;

  const button = new ButtonBuilder()
    .setCustomId(`accept_roles:${addId}:${remId}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  // Publication (bouton sur le 1er ou le dernier embed selon "place")
  let firstMsg = null;
  let lastMsg = null;

  for (let i = 0; i < embeds.length; i++) {
    const withButton =
      (place === "first" && i === 0) || (place === "last" && i === embeds.length - 1);

    const sent = await channel.send({
      embeds: [embeds[i]],
      components: withButton ? [row] : [],
    });

    if (i === 0) firstMsg = sent;
    if (i === embeds.length - 1) lastMsg = sent;
  }

  const linkMsg = place === "first" ? firstMsg : lastMsg;
  return interaction.reply({
    content: `✅ Panneau publié ici : ${linkMsg?.url ?? "#"}`,
    ephemeral: true,
  });
}

/* =========================
   Bouton: accept_roles:<addId|0>:<remId|0>
   Rétro-compat: accept_role_<roleId> (ajout simple)
   ========================= */
export async function handleAcceptRoleButton(interaction) {
  const id = interaction.customId;

  // Nouveau format (double action)
  if (id.startsWith("accept_roles:")) {
    const parts = id.split(":");
    const addId = parts[1] !== "0" ? parts[1] : null;
    const remId = parts[2] !== "0" ? parts[2] : null;

    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      try { await interaction.reply({ content: "❌ Membre introuvable.", ephemeral: true }); } catch {}
      return true;
    }

    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      try { await interaction.reply({ content: "⛔ Permission **Gérer les rôles** manquante.", ephemeral: true }); } catch {}
      return true;
    }

    const roleAdd = addId ? guild.roles.cache.get(addId) : null;
    const roleRem = remId ? guild.roles.cache.get(remId) : null;

    // Vérifier hiérarchie
    if (roleAdd && !canManageRole(me, roleAdd)) {
      try { await interaction.reply({ content: `⛔ Le bot ne peut pas **ajouter** @${roleAdd.name} (hiérarchie).`, ephemeral: true }); } catch {}
      return true;
    }
    if (roleRem && !canManageRole(me, roleRem)) {
      try { await interaction.reply({ content: `⛔ Le bot ne peut pas **retirer** @${roleRem.name} (hiérarchie).`, ephemeral: true }); } catch {}
      return true;
    }

    // Exécuter
    let added = false;
    let removed = false;

    try {
      if (roleAdd && !member.roles.cache.has(roleAdd.id)) {
        await member.roles.add(roleAdd.id, "Règlement accepté (add role)");
        added = true;
      }
      if (roleRem && member.roles.cache.has(roleRem.id)) {
        await member.roles.remove(roleRem.id, "Règlement accepté (remove role)");
        removed = true;
      }
    } catch {
      try { await interaction.reply({ content: "❌ Opération impossible (permissions/hiérarchie).", ephemeral: true }); } catch {}
      return true;
    }

    try {
    if (added || removed) {
        await interaction.reply({ content: "✅ Règlement validé", ephemeral: true });
    } else {
        await interaction.reply({ content: "❌ Problème de rôles", ephemeral: true });
    }
    } catch {
    try {
        await interaction.followUp({ content: "❌ Problème de rôles", ephemeral: true });
    } catch {}
    }
    return true;

  }

  // Ancien format (compat): accept_role_<roleId> → ajoute uniquement
  if (id.startsWith("accept_role_")) {
    const roleId = id.replace("accept_role_", "");
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      try { await interaction.reply({ content: "❌ Membre introuvable.", ephemeral: true }); } catch {}
      return true;
    }

    const me = guild.members.me;
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      try { await interaction.reply({ content: "❌ Rôle invalide.", ephemeral: true }); } catch {}
      return true;
    }

    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles) || !canManageRole(me, role)) {
      try { await interaction.reply({ content: "⛔ Le bot ne peut pas gérer ce rôle (permission/hiérarchie).", ephemeral: true }); } catch {}
      return true;
    }

    if (member.roles.cache.has(roleId)) {
      try { await interaction.reply({ content: "ℹ️ Tu as déjà ce rôle.", ephemeral: true }); } catch {}
      return true;
    }

    try {
      await member.roles.add(roleId, "Règlement accepté (add role - legacy)");
      await interaction.reply({ content: "✅ Rôle attribué.", ephemeral: true });
    } catch {
      try { await interaction.reply({ content: "❌ Impossible d’attribuer le rôle.", ephemeral: true }); } catch {}
    }
    return true;
  }

  return false;
}
