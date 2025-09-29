// src/features/cancelLog.js
import { ChannelType, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { col } from "../db/models.js";
import { requireRole } from "../lib/roles.js";

/**
 * CONFIG stockée en DB (collection "config")
 *   _id: `cancel_log:<guildId>`
 *   channelId: string
 *   messageId: string   // message unique à éditer
 *   updatedAt: Date
 *
 * EVENTS stockés en DB (collection "cancel_events")
 *   guildId: string
 *   userId: string
 *   rcId?: string | null
 *   reason: string      // "ready-check-expired", "manual-adjust", "manual-set", etc.
 *   w: number           // poids (+1, -1, +N...)
 *   createdAt: Date
 *
 * Le tableau est construit en agrégeant sum(w) par (guildId, userId).
 */

// ===== Helpers config =====

/** Récupère/assure le salon de log. Crée #liste-cancel-queue si absent et permissions OK. */
export async function getCancelLogChannel(guild) {
  const cfgId = `cancel_log:${guild.id}`;
  const cfg = await col("config").findOne({ _id: cfgId });

  // Si on a déjà un channelId valide, on le renvoie
  if (cfg?.channelId) {
    const ch = guild.channels.cache.get(cfg.channelId) || await guild.channels.fetch(cfg.channelId).catch(() => null);
    if (ch) return ch;
  }

  // Sinon on tente de le créer (si perms)
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return null;
  }

  let ch = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === "liste-cancel-queue"
  );
  if (!ch) {
    ch = await guild.channels.create({
      name: "liste-cancel-queue",
      type: ChannelType.GuildText,
      reason: "Salon de log des joueurs ne validant pas le ready-check",
    }).catch(() => null);
  }
  if (ch) {
    await col("config").updateOne(
      { _id: cfgId },
      { $set: { channelId: ch.id, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  return ch;
}

/** Assure le message unique; retourne { channel, message }. Recrée si nécessaire. */
async function ensureCancelLogMessage(guild) {
  const cfgId = `cancel_log:${guild.id}`;
  const channel = await getCancelLogChannel(guild);
  if (!channel) return { channel: null, message: null };

  let cfg = await col("config").findOne({ _id: cfgId });
  if (cfg?.messageId) {
    const msg = await channel.messages.fetch(cfg.messageId).catch(() => null);
    if (msg) return { channel, message: msg };
  }

  // Message initial
  const embed = new EmbedBuilder()
    .setTitle("Liste des joueurs — non validation du ready-check")
    .setDescription("Aucun joueur n’a encore manqué un ready-check.")
    .setTimestamp(new Date());

  const sent = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!sent) return { channel, message: null };

  await col("config").updateOne(
    { _id: cfgId },
    { $set: { channelId: channel.id, messageId: sent.id, updatedAt: new Date() } },
    { upsert: true }
  );
  return { channel, message: sent };
}

// ===== Board (message unique) =====

/** Met à jour le message unique avec le classement (agrégation sur cancel_events). */
export async function updateCancelLogBoard(client, guildId) {
  const gid = String(guildId);
  const guild = await client.guilds.fetch(gid).catch(() => null);
  if (!guild) return;

  // Assurer channel + (éventuellement) message
  const { channel, message } = await ensureCancelLogMessage(guild);
  if (!channel) return;

  // Data: sum(w) par user (>= 1)
  let rows = [];
  try {
    rows = await col("cancel_events").aggregate([
      { $match: { guildId: gid } },
      { $addFields: { w: { $ifNull: ["$w", 1] } } },
      { $group: { _id: "$userId", count: { $sum: "$w" } } },
      { $match: { count: { $gt: 0 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 200 },
    ]).toArray();
  } catch (e) {
    console.warn("[cancel-log] aggregation failed:", e?.message);
    rows = [];
  }

  // Lignes et coupe si besoin (4096 max dans description)
  let lines = rows.map((r, i) => `**${i + 1}.** <@${r._id}> — **${r.count}**`);
  if (lines.length === 0) lines = ["Aucun joueur n’a encore manqué un ready-check."];

  let desc = lines.join("\n");
  if (desc.length > 4000) {
    const cut = [];
    let total = 0;
    for (const l of lines) {
      if (total + l.length + 1 > 4000) break;
      cut.push(l);
      total += l.length + 1;
    }
    desc = cut.join("\n") + `\n… (${lines.length - cut.length} lignes supplémentaires)`;
  }

  const embed = new EmbedBuilder()
    .setTitle("Liste des joueurs — non validation du ready-check")
    .setDescription(desc)
    .setFooter({ text: "Mise à jour automatique" })
    .setTimestamp(new Date());

  // Edit si possible, sinon recrée et met à jour la config
  try {
    if (message) {
      await message.edit({ embeds: [embed], components: [] });
      return;
    }
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      await col("config").updateOne(
        { _id: `cancel_log:${gid}` },
        { $set: { channelId: channel.id, messageId: sent.id, updatedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (e) {
    console.warn("[cancel-log] edit/send failed:", e?.message);
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      await col("config").updateOne(
        { _id: `cancel_log:${gid}` },
        { $set: { channelId: channel.id, messageId: sent.id, updatedAt: new Date() } },
        { upsert: true }
      );
    }
  }
}

// ===== Logging des événements =====

/**
 * Enregistre +1 “no-ready” par user (w:1) dans cancel_events, puis met à jour le board.
 * @param {Client} client
 * @param {string} guildId
 * @param {string[]} userIds
 * @param {{ rcId?: string, reason?: string }} context
 */
export async function logReadyCancels(client, guildId, userIds, context = {}) {
  const gid = String(guildId);
  if (!userIds?.length) return;

  try {
    await col("cancel_events").insertMany(
      userIds.map(uid => ({
        guildId: gid,
        userId: String(uid),
        rcId: context.rcId ?? null,
        reason: context.reason ?? "ready-check-expired",
        w: 1, // +1
        createdAt: new Date(),
      }))
    );
  } catch (e) {
    console.warn("[cancel-log] insert events failed:", e?.message);
  }

  try { await updateCancelLogBoard(client, gid); } catch {}
}

// ===== Commandes admin =====

/** /setup_cancel_log channel:<#text> — force le salon (et recrée le message unique proprement) */
export async function handleSetupCancelLog(interaction) {
  if (!(await requireRole(interaction, "setup_cancel_log"))) return;

  const channel = interaction.options.getChannel("channel", true);
  await col("config").updateOne(
    { _id: `cancel_log:${interaction.guildId}` },
    { $set: { channelId: channel.id, messageId: null, updatedAt: new Date() } },
    { upsert: true }
  );

  const { message } = await ensureCancelLogMessage(interaction.guild);
  if (!message) {
    return interaction.reply({ content: "❌ Impossible de préparer le message de log (permissions ?)", ephemeral: true });
  }
  return interaction.reply({ content: `✅ Salon défini et message prêt: [ouvrir](${message.url})`, ephemeral: true });
}

/**
 * /cancel_adjust user:@x amount:<int> mode:(add|set)
 * - add: insère un événement avec w = amount (peut être négatif)
 * - set: insère un événement avec w = (amount - totalActuel)
 * Puis met à jour le board.
 */
export async function handleCancelAdjust(interaction) {
  if (!(await requireRole(interaction, "cancel_adjust"))) return;

  const user = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const mode = interaction.options.getString("mode") || "add"; // add | set

  const guildId = String(interaction.guildId);
  const userId = String(user.id);

  // Helper: total actuel (sum(w))
  async function getCurrentTotal() {
    const r = await col("cancel_events").aggregate([
      { $match: { guildId, userId } },
      { $addFields: { w: { $ifNull: ["$w", 1] } } },
      { $group: { _id: null, total: { $sum: "$w" } } },
      { $project: { _id: 0, total: 1 } }
    ]).toArray();
    return r[0]?.total ?? 0;
    }

  if (mode === "set") {
    const current = await getCurrentTotal();
    const delta = amount - current;
    if (delta === 0) {
      await updateCancelLogBoard(interaction.client, guildId);
      return interaction.reply({ content: `✅ Total inchangé pour <@${userId}>: **${current}**`, ephemeral: true });
    }

    await col("cancel_events").insertOne({
      guildId, userId,
      reason: "manual-set",
      w: delta, // applique la différence (peut être négative)
      createdAt: new Date(),
    });

    await updateCancelLogBoard(interaction.client, guildId);
    return interaction.reply({
      content: `✅ Nouveau total pour <@${userId}>: **${amount}** (Δ ${delta >= 0 ? "+" : ""}${delta}).`,
      ephemeral: true
    });
  }

  // mode === "add"
  if (amount === 0) {
    await updateCancelLogBoard(interaction.client, guildId);
    return interaction.reply({ content: "ℹ️ Ajout de 0 ignoré.", ephemeral: true });
  }

  await col("cancel_events").insertOne({
    guildId, userId,
    reason: "manual-adjust",
    w: amount, // +N ou -N
    createdAt: new Date(),
  });

  const newTotalArr = await col("cancel_events").aggregate([
    { $match: { guildId, userId } },
    { $addFields: { w: { $ifNull: ["$w", 1] } } },
    { $group: { _id: null, total: { $sum: "$w" } } },
    { $project: { _id: 0, total: 1 } }
  ]).toArray();
  const newTotal = newTotalArr[0]?.total ?? 0;

  await updateCancelLogBoard(interaction.client, guildId);
  return interaction.reply({
    content: `✅ Ajustement appliqué à <@${userId}>: **${amount >= 0 ? "+" : ""}${amount}** → total: **${newTotal}**`,
    ephemeral: true
  });
}
