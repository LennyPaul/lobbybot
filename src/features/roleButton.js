// src/features/roleButton.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";

// Split en blocs <= 4000 (limite Embed.description)
function splitIntoChunks(text, size = 4000) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks.length ? chunks : [text];
}

// Récupère le texte depuis l’option "text" ou un attachment .txt
async function resolveRulesText(interaction) {
  const txt = interaction.options.getString("text");
  const att = interaction.options.getAttachment("attachment");

  if (att) {
    // On attend un .txt ; Discord héberge le fichier sur CDN, on peut fetch l’URL
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      return body;
    } catch {
      throw new Error("Impossible de lire le fichier joint (attachment).");
    }
  }

  if (typeof txt === "string" && txt.trim().length) return txt.trim();

  throw new Error("Aucun texte fourni. Donne 'text' ou un attachment .txt.");
}

export async function handleRulesPanelCommand(interaction) {
  const role = interaction.options.getRole("role", true);
  const place = interaction.options.getString("button_place") || "first";
  const chosenChannel = interaction.options.getChannel("channel");
  const channel =
    (chosenChannel && chosenChannel.type === ChannelType.GuildText ? chosenChannel : interaction.channel);

  // Permissions bot dans le salon
  const me = interaction.guild.members.me;
  if (!me?.permissionsIn(channel)?.has(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: "⛔ Le bot n’a pas la permission d’envoyer des messages/embeds ici.", ephemeral: true });
  }

  let fullText;
  try {
    fullText = await resolveRulesText(interaction);
  } catch (e) {
    return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }

  // Découpe auto en embeds
  const chunks = splitIntoChunks(fullText, 4000);
  const embeds = chunks.map((c, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? "📜 Règlement du serveur" : `📜 Suite (${i + 1})`)
      .setDescription(c)
  );

  // Bouton rôle
  const button = new ButtonBuilder()
    .setCustomId(`accept_role_${role.id}`)
    .setLabel("✅ Accepter et obtenir le rôle")
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  // Envoi des messages
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

  // Réponse admin éphémère
  const linkMsg = place === "first" ? firstMsg : lastMsg;
  return interaction.reply({
    content: `✅ Panneau publié ici : ${linkMsg?.url ?? "#"} — Le bouton attribuera le rôle **@${role.name}**.`,
    ephemeral: true,
  });
}

// Gestion du clic sur le bouton
export async function handleAcceptRoleButton(interaction) {
  if (!interaction.customId.startsWith("accept_role_")) return false;
  const roleId = interaction.customId.replace("accept_role_", "");
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    try { await interaction.reply({ content: "❌ Membre introuvable.", ephemeral: true }); } catch {}
    return true;
  }

  // Vérifier que le bot peut donner le rôle (hiérarchie + permission)
  const me = interaction.guild.members.me;
  const canManage =
    me?.permissions?.has(PermissionFlagsBits.ManageRoles) &&
    (me.roles.highest?.position ?? 0) > (interaction.guild.roles.cache.get(roleId)?.position ?? 99999);

  if (!canManage) {
    try {
      await interaction.reply({
        content: "⛔ Le bot ne peut pas attribuer ce rôle (vérifie la hiérarchie des rôles et la permission Gérer les rôles).",
        ephemeral: true
      });
    } catch {}
    return true;
  }

  // Ajoute le rôle (toggle non demandé ; on ne fait que donner)
  if (member.roles.cache.has(roleId)) {
    try { await interaction.reply({ content: "ℹ️ Tu as déjà ce rôle.", ephemeral: true }); } catch {}
    return true;
  }

  try {
    await member.roles.add(roleId, "Acceptation du règlement via bouton");
    await interaction.reply({ content: "✅ Rôle attribué, merci d’avoir accepté le règlement !", ephemeral: true });
  } catch {
    try { await interaction.reply({ content: "❌ Impossible d’attribuer le rôle.", ephemeral: true }); } catch {}
  }
  return true;
}
