// src/features/onboarding.js
import "dotenv/config";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { col } from "../db/models.js";
import { requireRole } from "../lib/roles.js";

/**
 * CONFIG (collection config, _id: `onb:<guildId>`)
 * {
 *   _id: "onb:<guildId>",
 *   roleId?: string,                 // rôle à attribuer si accepté
 *   reviewChannelId?: string,        // salon où les admins reçoivent les demandes
 *   timeout?: number,                // pour info (si tu en uses)
 *   questions?: string[],            // questions pour la modal
 *   rules?: string,                  // texte du règlement à accepter
 *   panelChannelId?: string,         // salon du bouton "Commencer l'inscription"
 *   panelMessageId?: string,         // message avec le bouton
 *   updatedAt: Date
 * }
 *
 * SESSIONS (collection onboarding_sessions)
 * {
 *   guildId: string,
 *   userId: string,
 *   status: "rules" | "form" | "submitted" | "done",
 *   rulesAccepted?: boolean,
 *   createdAt: Date,
 *   updatedAt: Date
 * }
 */

const DEFAULT_QUESTIONS = [
  "Ton pseudo en jeu ?",
  "Ton rang ?",
  "As-tu un micro ?",
];

const DEFAULT_RULES = process.env.DEFAULT_RULES;

/* ---------------- Utils config ---------------- */

async function getOnbConfig(guildId) {
  const cfg = await col("config").findOne({ _id: `onb:${guildId}` });
  return {
    roleId: cfg?.roleId ?? null,
    reviewChannelId: cfg?.reviewChannelId ?? null,
    timeout: Number.isInteger(cfg?.timeout) ? cfg.timeout : 600,
    questions: Array.isArray(cfg?.questions) && cfg.questions.length ? cfg.questions : DEFAULT_QUESTIONS,
    rules: typeof cfg?.rules === "string" && cfg.rules.trim().length ? cfg.rules : DEFAULT_RULES,
    panelChannelId: cfg?.panelChannelId ?? null,
    panelMessageId: cfg?.panelMessageId ?? null,
  };
}

async function saveOnbConfig(guildId, patch) {
  await col("config").updateOne(
    { _id: `onb:${guildId}` },
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
}

/* ------------------- Panel setup ------------------- */

/** /onboarding_panel channel:<#text>  → place le bouton "Commencer l'inscription" */
export async function handleOnbPanel(interaction) {
  if (!(await requireRole(interaction, "onboarding_panel"))) return;

  const channel = interaction.options.getChannel("channel", true);
  if (channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: "Choisis un salon texte.", ephemeral: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`onb_start:${interaction.guildId}`)
      .setLabel("Commencer l'inscription")
      .setStyle(ButtonStyle.Primary)
  );

  const embed = new EmbedBuilder()
    .setTitle("Inscription au serveur")
    .setDescription("Clique sur le bouton pour **lire le règlement** puis répondre au formulaire d’inscription.");

  const sent = await channel.send({ embeds: [embed], components: [row] });
  await saveOnbConfig(interaction.guildId, { panelChannelId: channel.id, panelMessageId: sent.id });

  return interaction.reply({ content: "✅ Panneau d’inscription créé.", ephemeral: true });
}

/** /onboarding_settings: role/review/timeout/questions/rules (tous optionnels) */
export async function handleOnbSettings(interaction) {
  if (!(await requireRole(interaction, "onboarding_settings"))) return;

  const role = interaction.options.getRole("role");
  const reviewChannel = interaction.options.getChannel("review_channel");
  const timeout = interaction.options.getInteger("timeout");
  const questionsStr = interaction.options.getString("questions");
  const rulesStr = interaction.options.getString("rules"); // peut être long

  const patch = {};
  if (role) patch.roleId = role.id;
  if (reviewChannel && reviewChannel.type === ChannelType.GuildText) patch.reviewChannelId = reviewChannel.id;
  if (Number.isInteger(timeout)) patch.timeout = Math.max(60, Math.min(3600, timeout));
  if (typeof questionsStr === "string") {
    const arr = questionsStr.split("|").map(s => s.trim()).filter(Boolean);
    if (arr.length) patch.questions = arr.slice(0, 5); // modal max 5 inputs
  }
  if (typeof rulesStr === "string" && rulesStr.trim().length) patch.rules = rulesStr.trim();

  if (Object.keys(patch).length === 0) {
    return interaction.reply({ content: "Aucun paramètre fourni.", ephemeral: true });
  }

  await saveOnbConfig(interaction.guildId, patch);
  return interaction.reply({ content: "✅ Paramètres mis à jour.", ephemeral: true });
}

/* ------------------- Étape 1: Règlement ------------------- */

function buildRulesEmbed(rules) {
  return new EmbedBuilder()
    .setTitle("Règlement du serveur")
    .setDescription(rules.slice(0, 4000)) // sécurité
    .setFooter({ text: "Veuillez accepter pour continuer" });
}

function buildRulesButtons(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`onb_rules_accept:${guildId}`)
      .setLabel("J’accepte")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`onb_rules_decline:${guildId}`)
      .setLabel("Je refuse")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Bouton du panneau → affiche le règlement en éphémère avec 2 boutons */
export async function handleOnbStart(interaction) {
  const guildId = interaction.guildId;
  const cfg = await getOnbConfig(guildId);

  // crée/MAJ une session "rules"
  await col("onboarding_sessions").updateOne(
    { guildId, userId: interaction.user.id },
    {
      $set: {
        status: "rules",
        rulesAccepted: false,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  return interaction.reply({
    embeds: [buildRulesEmbed(cfg.rules)],
    components: [buildRulesButtons(guildId)],
    ephemeral: true,
  });
}

/** Boutons Accepter/Refuser du règlement */
export async function handleOnbRulesButton(interaction) {
  const [key, rest] = interaction.customId.split(":"); // onb_rules_accept:onbId
  if (!key?.startsWith("onb_rules_")) return false;

  const guildId = interaction.guildId;
  const accepted = key === "onb_rules_accept";

  if (!accepted) {
    // Refus
    await col("onboarding_sessions").updateOne(
      { guildId, userId: interaction.user.id },
      { $set: { status: "done", rulesAccepted: false, updatedAt: new Date() } },
      { upsert: true }
    );
    return interaction.update({
      content: "❌ Tu as refusé le règlement. Tu pourras recommencer depuis le panneau si besoin.",
      embeds: [],
      components: [],
    });
  }

  // Accepte → enchaîner sur la modal
  await col("onboarding_sessions").updateOne(
    { guildId, userId: interaction.user.id },
    { $set: { status: "form", rulesAccepted: true, updatedAt: new Date() } },
    { upsert: true }
  );

  const cfg = await getOnbConfig(guildId);
  const modal = new ModalBuilder()
    .setCustomId(`onb_modal:${guildId}`)
    .setTitle("Inscription");

  cfg.questions.slice(0, 5).forEach((q, idx) => {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q${idx}`)
          .setLabel(q.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400)
      )
    );
  });

  // On doit répondre à l'interaction avant showModal ? Non, showModal est OK direct.
  await interaction.showModal(modal);
  return true;
}

/* ------------------- Étape 2: Soumission modal ------------------- */

/** Traitement du modal: envoie au salon review avec boutons admin accepter/refuser */
export async function handleOnbModalSubmit(interaction) {
  if (!interaction.customId.startsWith("onb_modal:")) return false;
  const guildId = interaction.guildId;
  const cfg = await getOnbConfig(guildId);

  // Vérif session + règlement accepté
  const session = await col("onboarding_sessions").findOne({ guildId, userId: interaction.user.id });
  if (!session?.rulesAccepted) {
    return interaction.reply({ content: "Tu dois d’abord accepter le règlement.", ephemeral: true });
  }

  const answers = [];
  cfg.questions.slice(0, 5).forEach((q, idx) => {
    const v = interaction.fields.getTextInputValue(`q${idx}`);
    answers.push({ q, a: v });
  });

  await col("onboarding_sessions").updateOne(
    { guildId, userId: interaction.user.id },
    { $set: { status: "submitted", updatedAt: new Date() } }
  );

  // Envoi vers le salon review
  let ch = null;
  if (cfg.reviewChannelId) {
    ch = await interaction.guild.channels.fetch(cfg.reviewChannelId).catch(() => null);
  }
  if (!ch || ch.type !== ChannelType.GuildText) {
    return interaction.reply({ content: "Salon de review non configuré ou introuvable.", ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Nouvelle demande d’inscription — ${interaction.user.username}`)
    .setDescription(answers.map((x, i) => `**Q${i + 1}. ${x.q}**\n${x.a}`).join("\n\n"))
    .setFooter({ text: `ID: ${interaction.user.id}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`onb_admin_accept:${interaction.user.id}`)
      .setLabel("Accepter")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`onb_admin_refuse:${interaction.user.id}`)
      .setLabel("Refuser")
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await ch.send({ content: `Demande de <@${interaction.user.id}>`, embeds: [embed], components: [row] });

  await interaction.reply({ content: "✅ Demande envoyée. Un admin va te répondre.", ephemeral: true });
  return true;
}

/* ------------------- Décision admin ------------------- */

export async function handleOnbAdminButtons(interaction) {
  const [key, userId] = interaction.customId.split(":");
  if (!key?.startsWith("onb_admin_")) return false;

  // Tu peux aussi protéger par rôle spécifique si tu veux :
  // if (!(await requireRole(interaction, "onboarding_review"))) return true;

  const accept = key === "onb_admin_accept";
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const cfg = await getOnbConfig(interaction.guildId);

  if (accept) {
    if (cfg.roleId && member) {
      try { await member.roles.add(cfg.roleId, "Onboarding accepté"); } catch {}
    }
    await col("onboarding_sessions").updateOne(
      { guildId: interaction.guildId, userId },
      { $set: { status: "done", updatedAt: new Date() } },
      { upsert: true }
    );
    await interaction.update({ content: `✅ Accepté pour <@${userId}>`, embeds: [], components: [] });
    try { await member?.send("✅ Tu as été accepté, bienvenue !"); } catch {}
  } else {
    try { await member?.kick("Onboarding refusé"); } catch {}
    await col("onboarding_sessions").updateOne(
      { guildId: interaction.guildId, userId },
      { $set: { status: "done", updatedAt: new Date() } },
      { upsert: true }
    );
    await interaction.update({ content: `❌ Refusé pour <@${userId}> (kick)`, embeds: [], components: [] });
  }

  return true;
}
