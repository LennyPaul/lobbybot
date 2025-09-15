// src/features/queuePanel.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { col } from "../db/models.js";
import { tryStartMatch } from "./matchFlow.js";

/** ==================== CONFIG ==================== **/
const DEFAULT_READY_SECONDS = 60;

// Timers côté process pour un seul ready-check actif
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
    readySeconds: Number.isFinite(cfg?.readySeconds) ? cfg.readySeconds : DEFAULT_READY_SECONDS,
  };
}

/** ==================== UI: Queue Panel ==================== **/
function queueComponentsNormal() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("queue_join").setLabel("Rejoindre la file").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_leave").setLabel("Quitter la file").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function queueEmbedNormal(current) {
  const count = current.length;
  const preview = current.slice(0, 10).map((q, i) => `${i + 1}. <@${q.userId}>`).join("\n");
  return new EmbedBuilder()
    .setTitle("File d’attente — Valorant (5v5)")
    .setDescription(`**${count}/10** joueurs dans la file.\nUne validation de présence est requise avant le lancement.`)
    .addFields({ name: "En file (ordre d’arrivée)", value: preview || "—" })
    .setFooter({ text: "Clique sur les boutons pour rejoindre/partir." });
}

/** ====== Ready Check Rendering ====== */
function queueEmbedReadyCheck(rc, now = Date.now()) {
  const secondsLeft = Math.max(0, Math.ceil((new Date(rc.deadline).getTime() - now) / 1000));
  const confirmedSet = new Set(rc.confirmedIds);
  const lines = rc.userIds.map((u) => {
    const ok = confirmedSet.has(u);
    return `${ok ? "✅" : "⏳"} <@${u}>`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle("Validation de présence — 10/10 requis")
    .setDescription(
      `Clique **Valider ma présence** ci-dessous pour recevoir ton bouton **Je suis prêt** en privé (éphémère).\n` +
      `**Temps restant : ${secondsLeft}s** — Confirmés : **${rc.confirmedIds.length}/10**`
    )
    .addFields({ name: "Joueurs", value: lines || "—" })
    .setFooter({ text: "La partie démarre dès que 10/10 sont confirmés." });
}

function queueComponentsReadyCheck(rc) {
  // Un seul bouton public qui ouvre un message éphémère personnel
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rc_open_${rc.rcId}`)
        .setLabel("Valider ma présence")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

/** ============ Helpers Ready-Check ============ */
function newRcId() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function startReadyCheck(client) {
  // pas de RC si déjà en cours
  const already = await col("ready_checks").findOne({ status: "pending" });
  if (already) return true;

  // prend un snapshot des 10 premiers
  const list = await col("queue").find().sort({ joinedAt: 1 }).limit(10).toArray();
  if (list.length < 10) return false;

  const userIds = list.map((x) => x.userId);
  const { readySeconds } = await getQueueConfig();
  const cfg = await col("config").findOne({ _id: "queuePanel" });
  if (!cfg?.channelId || !cfg?.messageId) return false;

  const rcDoc = {
    rcId: newRcId(),
    status: "pending",
    userIds,
    confirmedIds: [],
    channelId: cfg.channelId,
    messageId: cfg.messageId,
    createdAt: new Date(),
    deadline: new Date(Date.now() + readySeconds * 1000),
  };
  await col("ready_checks").insertOne(rcDoc);

  // timers UI + expiration
  const interval = setInterval(async () => {
    try { await refreshQueuePanel(client); } catch {}
  }, 1000);
  rcIntervals.set(rcDoc.rcId, interval);

  const timeout = setTimeout(async () => {
    await expireReadyCheck(client, rcDoc.rcId);
  }, readySeconds * 1000);
  rcTimeouts.set(rcDoc.rcId, timeout);

  await refreshQueuePanel(client);
  return true;
}

async function expireReadyCheck(client, rcId) {
  clearRcTimers(rcId);
  const rc = await col("ready_checks").findOne({ rcId });
  if (!rc || rc.status !== "pending") return;

  const confirmedSet = new Set(rc.confirmedIds);
  const unconfirmed = rc.userIds.filter((u) => !confirmedSet.has(u));

  // Retire les non-confirmés de la file (s’ils y sont encore)
  if (unconfirmed.length) {
    await col("queue").deleteMany({ userId: { $in: unconfirmed } });
  }

  await col("ready_checks").updateOne(
    { rcId },
    { $set: { status: "expired", endedAt: new Date() } }
  );

  await refreshQueuePanel(client);
  try { await maybeLaunchReadyCheckOrStart(client); } catch {}
}

async function completeReadyCheck(client, rcId) {
  clearRcTimers(rcId);
  const rc = await col("ready_checks").findOne({ rcId });
  if (!rc || rc.status !== "pending") return;

  // priorité : on “met en tête” ces 10 joueurs en ajustant leurs joinedAt
  const base = new Date("2000-01-01T00:00:00.000Z").getTime();
  const bulk = col("queue").initializeUnorderedBulkOp();
  rc.userIds.forEach((u, idx) => {
    bulk.find({ userId: u }).updateOne({ $set: { joinedAt: new Date(base + idx) } });
  });
  try { if (bulk.length) await bulk.execute(); } catch {}

  await col("ready_checks").updateOne(
    { rcId },
    { $set: { status: "complete", endedAt: new Date() } }
  );

  await refreshQueuePanel(client);
  // 🚀 On ne crée la game que maintenant :
  await tryStartMatch(client);
}

/** ============ Export public : déclencheur auto ============ */
export async function maybeLaunchReadyCheckOrStart(client) {
  // si un RC est en cours, ne rien faire
  const pending = await col("ready_checks").findOne({ status: "pending" });
  if (pending) return;

  // si <10 joueurs → rien
  const count = await col("queue").countDocuments();
  if (count < 10) return;

  // sinon lancer un RC
  await startReadyCheck(client);
}

/** ============ Public API: refreshQueuePanel ============ */
export async function refreshQueuePanel(client) {
  const cfg = await col("config").findOne({ _id: "queuePanel" });
  if (!cfg?.channelId || !cfg?.messageId) return;

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(cfg.messageId).catch(() => null);

  // Y a-t-il un ready-check actif ?
  const rc = await col("ready_checks").findOne({ status: "pending" });
  if (rc) {
    const embed = queueEmbedReadyCheck(rc);
    const components = queueComponentsReadyCheck(rc);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
    } else {
      const sent = await channel.send({ embeds: [embed], components });
      await col("config").updateOne({ _id: "queuePanel" }, { $set: { messageId: sent.id } }, { upsert: true });
    }
    return;
  }

  // Sinon, affichage normal
  const current = await col("queue").find().sort({ joinedAt: 1 }).toArray();
  const embed = queueEmbedNormal(current);
  const components = queueComponentsNormal();
  if (msg) {
    await msg.edit({ embeds: [embed], components });
  } else {
    const sent = await channel.send({ embeds: [embed], components });
    await col("config").updateOne({ _id: "queuePanel" }, { $set: { messageId: sent.id } }, { upsert: true });
  }

  // Si on a 10+ joueurs et aucun RC → lancer
  if (current.length >= 10) {
    try { await maybeLaunchReadyCheckOrStart(client); } catch {}
  }
}

/** ==================== /setup ==================== */
export async function handleSetup(interaction) {
  const channel = interaction.channel;
  if (!channel?.permissionsFor?.(interaction.client.user)?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({ content: "Je ne peux pas envoyer de messages ici.", ephemeral: true });
  }

  const current = await col("queue").find().sort({ joinedAt: 1 }).toArray();
  const embed = queueEmbedNormal(current);
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

  // === READY: ouvrir l’éphémère ===
  if (id.startsWith("rc_open_")) {
    const rcId = id.substring("rc_open_".length);
    const rc = await col("ready_checks").findOne({ rcId, status: "pending" });
    if (!rc) {
      return interaction.reply({ content: "Ready-check expiré ou introuvable.", ephemeral: true });
    }
    if (!rc.userIds.includes(interaction.user.id)) {
      return interaction.reply({ content: "Tu ne fais pas partie de ces 10 joueurs.", ephemeral: true });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rc_confirm_${rcId}`)
        .setLabel("Je suis prêt ✅")
        .setStyle(ButtonStyle.Success)
    );

    const secondsLeft = Math.max(0, Math.ceil((new Date(rc.deadline).getTime() - Date.now()) / 1000));
    return interaction.reply({
      content: `Valide ta présence pour ce match (temps restant **${secondsLeft}s**).`,
      components: [row],
      ephemeral: true,
    });
  }

  // === READY: confirmer dans l’éphémère ===
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
      return interaction.update({ content: "Déjà validé ✅", components: [] });
    }

    const updated = await col("ready_checks").findOneAndUpdate(
      { rcId, status: "pending" },
      { $addToSet: { confirmedIds: userId }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    try { await interaction.update({ content: "Présence validée ✅", components: [] }); } catch {}
    try { await refreshQueuePanel(client); } catch {}

    const allOk = updated?.value && updated.value.userIds.every(u => updated.value.confirmedIds.includes(u));
    if (allOk) {
      await completeReadyCheck(client, rcId);
    }
    return;
  }

  // === QUEUE BUTTONS ===
  if (id !== "queue_join" && id !== "queue_leave") return;

  const userId = interaction.user.id;

  try {
    if (id === "queue_join") {
      // check déjà en match actif ?
      const active = await col("match_players").aggregate([
        { $match: { userId } },
        { $lookup: { from: "matches", localField: "matchId", foreignField: "matchId", as: "m" } },
        { $unwind: "$m" },
        { $match: { "m.status": { $nin: ["closed", "reversed", "abandoned"] } } },
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
        { $setOnInsert: { userId, rating: 1000, gamesPlayed: 0, banned: false, createdAt: new Date() }, $set: { updatedAt: new Date() } },
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

/** ==================== Commande admin: config du ready-time ==================== */
export async function handleQueueReadyConfig(interaction) {
  const secs = interaction.options.getInteger("ready_seconds", true);
  if (secs < 10 || secs > 600) {
    return interaction.reply({ content: "Valeur invalide. Choisis entre 10 et 600 secondes.", ephemeral: true });
  }
  await col("config").updateOne(
    { _id: "queue" },
    { $set: { readySeconds: secs, updatedAt: new Date() } },
    { upsert: true }
  );
  return interaction.reply({ content: `⏱️ Délai de validation fixé à **${secs}s**.`, ephemeral: true });
}
