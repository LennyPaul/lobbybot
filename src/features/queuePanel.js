// src/features/queuePanel.js
import 'dotenv/config';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { col } from "../db/models.js";
import { tryStartMatch } from "./matchFlow.js";
import { logReadyCancels } from "./cancelLog.js";


/** ==================== CONFIG ==================== **/
const DEFAULT_READY_SECONDS = 60;

const rcIntervals = new Map(); // rcId -> setInterval
const rcTimeouts = new Map();  // rcId -> setTimeout

function clearRcTimers(rcId) {
  const i = rcIntervals.get(rcId);
  if (i) { clearInterval(i); rcIntervals.delete(rcId); }
  const t = rcTimeouts.get(rcId);
  if (t) { clearTimeout(t); rcTimeouts.delete(rcId); }
}

async function getQueueConfig() {
  const cfg = await col("config").findOne({ _id: "queue" });
  return {
    readyEnabled: cfg?.readyEnabled ?? true,
    readySeconds: Number.isFinite(cfg?.readySeconds) ? cfg.readySeconds : DEFAULT_READY_SECONDS,
  };
}

/** ==================== UI: Panneau de queue ==================== **/
function queueComponentsNormal() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("queue_join").setLabel("Rejoindre la file").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_leave").setLabel("Quitter la file").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function queueEmbedNormal() {
  const current = await col("queue").find().sort({ joinedAt: 1 }).toArray();
  const { readyEnabled } = await getQueueConfig();
  const count = current.length;
  const preview = current.slice(0, 10).map((q, i) => `${i + 1}. <@${q.userId}>`).join("\n");
  return new EmbedBuilder()
    .setTitle("File d’attente — Valorant (5v5)")
    .setDescription(
      `**${count}/10** joueurs en file.\n` +
      (readyEnabled
        ? "Un **ready-check** sera lancé pour les 10 premiers."
        : "La partie se **lance automatiquement** dès qu’il y a **10 joueurs**.")
    )
    .setFooter({ text: "Clique sur les boutons pour rejoindre/partir." });
}

export async function refreshQueuePanel(client) {
  const cfg = await col("config").findOne({ _id: "queuePanel" });
  if (!cfg?.channelId || !cfg?.messageId) return;

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(cfg.messageId).catch(() => null);
  const embed = await queueEmbedNormal();
  const components = queueComponentsNormal();

  if (msg) {
    await msg.edit({ embeds: [embed], components });
  } else {
    const sent = await channel.send({ embeds: [embed], components });
    await col("config").updateOne({ _id: "queuePanel" }, { $set: { messageId: sent.id } }, { upsert: true });
  }
}

/** ==================== Ready-check status (séparé du panneau) ==================== **/
function rcStatusEmbed(rc) {
  const secondsLeft = Math.max(0, Math.ceil((new Date(rc.deadline).getTime() - Date.now()) / 1000));
  const confirmed = new Set(rc.confirmedIds || []);
  const lines = rc.userIds.map(u => `${confirmed.has(u) ? "✅" : "⏳"} <@${u}>`).join("\n");

  return new EmbedBuilder()
    .setTitle(`Ready-check — ${rc.confirmedIds.length}/10 confirmés`)
    .setDescription(
      `Chaque joueur a reçu un **DM** avec un bouton “Je suis prêt ✅”.\n` +
      `**Temps restant : ${secondsLeft}s**\n` +
      `La partie se crée dès que **10/10** sont confirmés.`
    )
    .setFooter({ text: "Ce message s’actualise automatiquement." });
}

async function upsertRcStatusMessage(client, rc) {
  const cfg = await col("config").findOne({ _id: "queuePanel" });
  if (!cfg?.channelId) return null;
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return null;

  const embed = rcStatusEmbed(rc);
  if (rc.statusMessageId) {
    const msg = await channel.messages.fetch(rc.statusMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [] });
      return msg.id;
    }
  }
  const sent = await channel.send({ embeds: [embed] });
  return sent.id;
}

async function deleteRcStatusMessage(client, rc) {
  if (!rc?.statusMessageId) return;
  try {
    const cfg = await col("config").findOne({ _id: "queuePanel" });
    if (!cfg?.channelId) return;
    const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(rc.statusMessageId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
  } catch {}
}

/** ==================== Ready-check: DM aux joueurs ==================== **/
function buildReadyDmRow(rcId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rc_confirm_${rcId}`)
      .setLabel("Je suis prêt ✅")
      .setStyle(ButtonStyle.Success)
  );
}

async function notifyPlayersViaDM(client, rc) {
  const row = buildReadyDmRow(rc.rcId);
  const secondsLeft = Math.max(0, Math.ceil((new Date(rc.deadline).getTime() - Date.now()) / 1000));
  const text =
    `Tu as été sélectionné pour un match perso.\n` +
    `Clique sur le bouton ci-dessous pour **valider ta présence**.\n` +
    `Temps pour valider : **${secondsLeft}s**.`;

  for (const userId of rc.userIds) {
    if (userId.startsWith("f_")) continue; // pas de DM pour fakes
    try {
      const user = await client.users.fetch(userId);
      const dm = await user.createDM();
      await dm.send({ content: text, components: [row] });
    } catch {
      // DM fermés : on ignore
    }
  }
}

/** ==================== Lancement / cycle du Ready-check ==================== **/
function newRcId() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function startReadyCheck(client) {
  const already = await col("ready_checks").findOne({ status: "pending" });
  if (already) return true;

  const list = await col("queue").find().sort({ joinedAt: 1 }).limit(10).toArray();
  if (list.length < 10) return false;

  const userIds = list.map(x => x.userId);
  const { readySeconds } = await getQueueConfig();

  const rcDoc = {
    rcId: newRcId(),
    status: "pending",
    userIds,
    confirmedIds: [],
    createdAt: new Date(),
    deadline: new Date(Date.now() + readySeconds * 1000),
    statusMessageId: null,
  };
  await col("ready_checks").insertOne(rcDoc);

  const id = await upsertRcStatusMessage(client, rcDoc).catch(() => null);
  if (id) {
    await col("ready_checks").updateOne({ rcId: rcDoc.rcId }, { $set: { statusMessageId: id } });
    rcDoc.statusMessageId = id;
  }

  await notifyPlayersViaDM(client, rcDoc);

  const interval = setInterval(async () => {
    try {
      const fresh = await col("ready_checks").findOne({ rcId: rcDoc.rcId });
      if (!fresh || fresh.status !== "pending") return clearRcTimers(rcDoc.rcId);
      await upsertRcStatusMessage(client, fresh);
    } catch {}
  }, 1000);
  rcIntervals.set(rcDoc.rcId, interval);

  const timeout = setTimeout(async () => {
    await expireReadyCheck(client, rcDoc.rcId);
  }, readySeconds * 1000);
  rcTimeouts.set(rcDoc.rcId, timeout);

  return true;
}

async function expireReadyCheck(client, rcId) {
  clearRcTimers(rcId);
  const rc = await col("ready_checks").findOne({ rcId });
  if (!rc || rc.status !== "pending") return;

  const confirmedSet = new Set(rc.confirmedIds);
  const unconfirmed = rc.userIds.filter(u => !confirmedSet.has(u));

  if (unconfirmed.length) {

    try { await logReadyCancels(client, process.env.GUILD_ID, unconfirmed, { rcId }); } catch {}
    await col("queue").deleteMany({ userId: { $in: unconfirmed } });

  }

  await col("ready_checks").updateOne(
    { rcId },
    { $set: { status: "expired", endedAt: new Date() } }
  );

  await deleteRcStatusMessage(client, rc).catch(() => {});
  await refreshQueuePanel(client);
  try { await maybeLaunchReadyCheckOrStart(client); } catch {}
}

/** 🔒 Upsert + place VRAIMENT les 10 joueurs du RC en tête de file */
async function ensureRcUsersAtFront(userIds) {
  const now = new Date();
  const bulkUpsert = col("queue").initializeUnorderedBulkOp();
  for (const u of userIds) {
    bulkUpsert.find({ userId: u }).upsert().updateOne({
      $setOnInsert: { userId: u, joinedAt: now },
    });
  }
  try { await bulkUpsert.execute(); } catch {}

  const far = new Date(Date.now() + 365 * 24 * 3600 * 1000); // +1 an
  await col("queue").updateMany({ userId: { $nin: userIds } }, { $set: { joinedAt: far } });

  const base = new Date(0).getTime();
  const bulkOrder = col("queue").initializeUnorderedBulkOp();
  userIds.forEach((u, idx) => {
    bulkOrder.find({ userId: u }).updateOne({ $set: { joinedAt: new Date(base + idx) } });
  });
  try { await bulkOrder.execute(); } catch {}

  const top = await col("queue").find().sort({ joinedAt: 1 }).limit(10).toArray();
  const topIds = top.map(x => x.userId);
  const ok = userIds.length === topIds.length && userIds.every((u, i) => u === topIds[i]);
  return ok;
}

async function completeReadyCheck(client, rcId) {
  clearRcTimers(rcId);
  const rc = await col("ready_checks").findOne({ rcId });
  if (!rc || rc.status !== "pending") return;

  const ok = await ensureRcUsersAtFront(rc.userIds);
  if (!ok) console.warn("[ready-check] ensureRcUsersAtFront mismatch — on tente quand même.");

  await col("ready_checks").updateOne(
    { rcId },
    { $set: { status: "complete", endedAt: new Date() } }
  );

  await deleteRcStatusMessage(client, rc).catch(() => {});
  await refreshQueuePanel(client);

  await tryStartMatch(client);
}

/** ============ Déclencheur auto ============ */
export async function maybeLaunchReadyCheckOrStart(client) {
  const { readyEnabled } = await getQueueConfig();

  const pending = await col("ready_checks").findOne({ status: "pending" });
  if (readyEnabled && pending) return;

  const count = await col("queue").countDocuments();
  if (count < 10) return;

  if (readyEnabled) {
    await startReadyCheck(client);
  } else {
    await tryStartMatch(client);
  }
}

/** ==================== /setup ==================== */
export async function handleSetup(interaction) {
  const channel = interaction.channel;
  if (!channel?.permissionsFor?.(interaction.client.user)?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: "Je ne peux pas envoyer de messages ici.", ephemeral: true });
  }

  const embed = await queueEmbedNormal();
  const components = queueComponentsNormal();
  const sent = await channel.send({ embeds: [embed], components });

  await col("config").updateOne(
    { _id: "queuePanel" },
    { $set: { channelId: channel.id, messageId: sent.id, updatedAt: new Date() } },
    { upsert: true }
  );

  return interaction.reply({ content: "Panneau de file d’attente installé ✅", ephemeral: true });
}

/** ==================== Boutons joueurs (queue + ready) ==================== */
export async function handleQueueButtons(interaction, client) {
  const id = interaction.customId;

  // === READY CONFIRM depuis DM ===
  if (id.startsWith("rc_confirm_")) {
    const rcId = id.substring("rc_confirm_".length);
    const rc = await col("ready_checks").findOne({ rcId, status: "pending" });
    if (!rc) {
      return interaction.reply({ content: "Ready-check expiré ou introuvable.", ephemeral: true });
    }
    const userId = interaction.user.id;
    if (!rc.userIds.includes(userId)) {
      return interaction.reply({ content: "Tu ne fais pas partie de ces 10 joueurs.", ephemeral: true });
    }
    if (rc.confirmedIds.includes(userId)) {
      return interaction.reply({ content: "Déjà validé ✅", ephemeral: true });
    }

    await col("ready_checks").updateOne(
      { rcId, status: "pending" },
      { $addToSet: { confirmedIds: userId }, $set: { updatedAt: new Date() } }
    );

    const fresh = await col("ready_checks").findOne({ rcId });
    const need = new Set((fresh?.userIds ?? []).map(String));
    const confirmed = new Set((fresh?.confirmedIds ?? []).map(String));
    const allOk = need.size > 0 && [...need].every(u => confirmed.has(u));

    try { await interaction.reply({ content: "Présence validée ✅", ephemeral: true }); } catch {}
    try { await upsertRcStatusMessage(client, fresh); } catch {}

    if (allOk && fresh?.status === "pending") {
      await completeReadyCheck(client, rcId);
    }
    return;
  }

  // === QUEUE BUTTONS ===
  if (id !== "queue_join" && id !== "queue_leave") return;

  const userId = interaction.user.id;

  try {
    if (id === "queue_join") {
      const active = await col("match_players").aggregate([
        { $match: { userId } },
        { $lookup: { from: "matches", localField: "matchId", foreignField: "matchId", as: "m" } },
        { $unwind: "$m" },
        { $match: { "m.status": { $nin: ["closed", "reversed", "abandoned","review"] } } },
        { $limit: 1 }
      ]).toArray();
      if (active.length) {
        return interaction.reply({ content: `Impossible de rejoindre : tu es déjà dans un **match en cours** (#${active[0]?.matchId}).`, ephemeral: true });
      }

      const player = await col("players").findOne({ userId }, { projection: { banned: 1 } });
      if (player?.banned) {
        return interaction.reply({ content: "Impossible de rejoindre : tu es banni de la file.", ephemeral: true });
      }
      const exists = await col("queue").findOne({ userId });
      if (exists) {
        return interaction.reply({ content: "Impossible de rejoindre : tu es déjà dans la file.", ephemeral: true });
      }

      await col("players").updateOne(
        { userId },
        { $setOnInsert: { userId, rating: 100, gamesPlayed: 0, banned: false, createdAt: new Date() }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      await col("queue").insertOne({ userId, joinedAt: new Date() });
    }

    if (id === "queue_leave") {
      const exists = await col("queue").findOne({ userId });
      if (!exists) {
        return interaction.reply({ content: "Impossible de quitter : tu n’es pas dans la file.", ephemeral: true });
      }
      await col("queue").deleteOne({ userId });
    }

    await interaction.deferUpdate().catch(() => {});
    await refreshQueuePanel(client);
    await maybeLaunchReadyCheckOrStart(client);
  } catch (e) {
    console.warn("[queueButtons] error:", e.message);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: "Erreur inattendue.", ephemeral: true }); } catch {}
    }
  }
}

/** ==================== Commande admin: config queue ====================
 * /queue_settings enabled:<bool?> ready_seconds:<int?>
 */
export async function handleQueueReadyConfig(interaction) {
  // ✅ répond tout de suite pour éviter "application ne répond plus"
  await interaction.deferReply({ ephemeral: true });

  const enabledOpt = interaction.options.getBoolean("enabled"); // peut être null
  const secsOpt = interaction.options.getInteger("ready_seconds"); // peut être null

  if (enabledOpt === null && secsOpt === null) {
    return interaction.editReply("Aucun paramètre fourni. Rien n’a été changé.");
  }

  const update = {};
  if (enabledOpt !== null) update.readyEnabled = enabledOpt;
  if (Number.isInteger(secsOpt)) {
    if (secsOpt < 10 || secsOpt > 600) {
      return interaction.editReply("Valeur invalide pour ready_seconds (10..600).");
    }
    update.readySeconds = secsOpt;
  }

  await col("config").updateOne(
    { _id: "queue" },
    { $set: { ...update, updatedAt: new Date() } },
    { upsert: true }
  );

  // Si on désactive le RC, on arrête proprement celui en cours
  if (enabledOpt === false) {
    const rc = await col("ready_checks").findOne({ status: "pending" });
    if (rc) {
      clearRcTimers(rc.rcId);
      await deleteRcStatusMessage(interaction.client, rc).catch(() => {});
      await col("ready_checks").updateOne({ rcId: rc.rcId }, { $set: { status: "expired", endedAt: new Date() } });
    }
  }

  const cfg = await getQueueConfig();
  await interaction.editReply(
    `Config file mise à jour ✅\n` +
    `- Ready-check: **${cfg.readyEnabled ? "activé" : "désactivé"}**\n` +
    `- Délai ready: **${cfg.readySeconds}s**`
  );

  // Lancer/relancer suivant nouvelle config si on a 10+
  try { await maybeLaunchReadyCheckOrStart(interaction.client); } catch {}
}
