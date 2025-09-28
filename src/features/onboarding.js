// src/features/onboarding.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { col } from "../db/models.js";

/**
 * /setup_onboarding
 * Crée le message permanent avec le bouton "Commencer l'inscription"
 */
export async function handleSetupOnboarding(interaction) {
  const channel = interaction.options.getChannel("channel", true);
  const adminChannel = interaction.options.getChannel("admin_channel", true);
  const role = interaction.options.getRole("role", true);

  await col("config").updateOne(
    { _id: "onboarding" },
    {
      $set: {
        channelId: channel.id,
        adminChannelId: adminChannel.id,
        roleId: role.id,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("onb_start")
      .setLabel("Commencer l'inscription")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Inscription")
        .setDescription(
          "Bienvenue sur le serveur 🎉\nClique sur le bouton ci-dessous pour commencer ton inscription."
        ),
    ],
    components: [row],
  });

  return interaction.reply({
    content: "✅ Système d'inscription configuré.",
    ephemeral: true,
  });
}

/**
 * /onb_set_questions
 * Définir dynamiquement les questions (séparées par |)
 */
export async function handleOnbSetQuestions(interaction) {
  const raw = interaction.options.getString("questions", true);
  const parts = raw.split("|").map(s => s.trim()).filter(Boolean);

  if (parts.length === 0) {
    return interaction.reply({ content: "❌ Aucune question valide.", ephemeral: true });
  }

  const questions = parts.map((q, i) => ({
    id: `q${i + 1}`,
    label: q,
    style: q.length < 100 ? "short" : "paragraph",
  }));

  await col("config").updateOne(
    { _id: "onboarding_questions" },
    { $set: { questions, updatedAt: new Date() } },
    { upsert: true }
  );

  return interaction.reply({
    content: `✅ Questions d'inscription mises à jour :\n- ${parts.join("\n- ")}`,
    ephemeral: true,
  });
}

/**
 * /onb_show_questions
 * Voir les questions actuelles
 */
export async function handleOnbShowQuestions(interaction) {
  const cfg = await col("config").findOne({ _id: "onboarding_questions" });
  if (!cfg?.questions?.length) {
    return interaction.reply({
      content: "❌ Aucune question configurée.",
      ephemeral: true,
    });
  }

  const txt = cfg.questions.map((q, i) => `${i + 1}. ${q.label}`).join("\n");
  return interaction.reply({ content: `📋 Questions actuelles :\n${txt}`, ephemeral: true });
}

/**
 * Clic sur "Commencer l'inscription" → ouvre la modal
 */
export async function handleOnbStart(interaction) {
  const cfg = await col("config").findOne({ _id: "onboarding_questions" });
  const questions = cfg?.questions?.length
    ? cfg.questions
    : [
        { id: "q1", label: "Quel est ton pseudo en jeu ?", style: "short" },
        { id: "q2", label: "Quel est ton rang/expérience ?", style: "paragraph" },
        { id: "q3", label: "Qu'attends-tu du serveur ?", style: "paragraph" },
      ];

  const modal = new ModalBuilder()
  .setCustomId("onb_modal")
  .setTitle("Inscription");

  for (const q of questions.slice(0, 5)) { // max 5 inputs Discord
    const full = (q.label ?? "").trim();
    const label = full.length > 45 ? `${full.slice(0, 42)}…` : full;       // <= 45
    const placeholder = full.slice(0, 100);                                  // placeholder max 100

    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setStyle(q.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  await interaction.showModal(modal);
}

/**
 * Réception des réponses de la modal
 */
export async function handleOnbModal(interaction, client) {
  const cfg = await col("config").findOne({ _id: "onboarding" });
  const qcfg = await col("config").findOne({ _id: "onboarding_questions" });
  const questions = qcfg?.questions ?? [];

  if (!cfg) {
    return interaction.reply({ content: "❌ Système non configuré.", ephemeral: true });
  }

  const answers = {};
  for (const q of questions) {
    answers[q.label] = interaction.fields.getTextInputValue(q.id);
  }

  // Sauvegarde en DB
  await col("onboarding").updateOne(
    { userId: interaction.user.id },
    {
      $set: {
        userId: interaction.user.id,
        answers,
        status: "pending",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  // Envoi aux admins
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`onb_accept_${interaction.user.id}`)
      .setLabel("Accepter ✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`onb_reject_${interaction.user.id}`)
      .setLabel("Refuser ❌")
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle("Nouvelle demande d'inscription")
    .setDescription(`Utilisateur: <@${interaction.user.id}>`)
    .addFields(Object.entries(answers).map(([label, val]) => ({
      name: label,
      value: val || "—",
    })))
    .setTimestamp();

  const adminChan = await client.channels.fetch(cfg.adminChannelId);
  await adminChan.send({ embeds: [embed], components: [row] });

  await interaction.reply({
    content: "✅ Tes réponses ont été envoyées aux admins, tu seras bientôt notifié.",
    ephemeral: true,
  });
}

/**
 * Boutons admin accepter/refuser
 */
export async function handleOnbDecision(interaction) {
  const cfg = await col("config").findOne({ _id: "onboarding" });
  if (!cfg) return;

  const [_, action, userId] = interaction.customId.split("_");

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) {
    return interaction.reply({ content: "Utilisateur introuvable.", ephemeral: true });
  }

if (action === "accept") {
  const me = interaction.guild.members.me;
  const targetRole = interaction.guild.roles.cache.get(cfg.roleId);

  if (!targetRole) {
    return interaction.reply({ content: "❌ Rôle configuré introuvable.", ephemeral: true });
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({ content: "❌ Je n’ai pas la permission **Gérer les rôles**.", ephemeral: true });
  }
  if (targetRole.managed) {
    return interaction.reply({ content: "❌ Ce rôle est **géré** par une intégration et ne peut pas être attribué.", ephemeral: true });
  }
  if (targetRole.position >= me.roles.highest.position) {
    return interaction.reply({ content: `❌ Mon rôle est **trop bas** dans la hiérarchie.\nPlace mon rôle **au-dessus** de ${targetRole.toString()}.`, ephemeral: true });
  }

  try {
    await member.roles.add(cfg.roleId, "Onboarding approuvé");
  } catch (e) {
    return interaction.reply({ content: `❌ Impossible d’ajouter le rôle (${e.code || e.message}).`, ephemeral: true });
  }

  await col("onboarding").updateOne(
    { userId },
    { $set: { status: "accepted", updatedAt: new Date() } }
  );
  return interaction.update({ content: `✅ <@${userId}> accepté.`, components: [], embeds: [] });
}

if (action === "reject") {
  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.KickMembers)) {
    return interaction.reply({ content: "❌ Je n’ai pas la permission **Expulser des membres**.", ephemeral: true });
  }
  try {
    await member.kick("Onboarding refusé");
  } catch (e) {
    return interaction.reply({ content: `❌ Impossible de kick (${e.code || e.message}).`, ephemeral: true });
  }
  await col("onboarding").updateOne(
    { userId },
    { $set: { status: "rejected", updatedAt: new Date() } }
  );
  return interaction.update({ content: `❌ <@${userId}> refusé et expulsé.`, components: [], embeds: [] });
}
}
