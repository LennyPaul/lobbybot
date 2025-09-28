// src/features/matchFlow.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { col, getNextSequence } from "../db/models.js";
import { refreshQueuePanel } from "./queuePanel.js";
import { startVeto, buildRecapEmbed, computeCaptains } from "./veto.js";
import { refreshLeaderboard, upsertMatchHistoryMessage } from "./boards.js";
import { createMatchVoiceChannels, cleanupMatchVoiceChannels } from "./voiceRooms.js";
import { requireRole } from "../lib/roles.js"; 


async function disableMessageComponents(channel, messageId) {
  try {
    const msg = await channel.messages.fetch(messageId);
    const embeds = msg.embeds?.length ? msg.embeds : [];
    await msg.edit({ embeds, components: [] });
  } catch {}
}

// Désactive une liste de messages dans le thread du match
async function disableMatchComponents(client, match) {
  try {
    if (!match?.threadId) return;
    const thread = await client.channels.fetch(match.threadId);

    const ids = [
      match.recapMessageId,
      match.vetoMessageId,
      match.voteMessageId,
    ].filter(Boolean);

    for (const mid of ids) {
      await disableMessageComponents(thread, mid);
    }
  } catch {}
}


async function updateAdminReviewMessage(client, matchId, winner = null) {
  const match = await col("matches").findOne(
    { matchId },
    { projection: { reviewChannelId: 1, reviewMessageId: 1, teamA: 1, teamB: 1, pickedMap: 1, capVotes: 1, status: 1 } }
  );
  if (!match?.reviewChannelId || !match?.reviewMessageId) return;

  // Embeds "final" si winner connu
  const decided = winner ?? match.winner ?? null;
  const color = decided ? (decided === "A" ? 0x2ECC71 : 0xE74C3C) : 0xF39C12;

  const voteTxtA = match.capVotes?.A ? `Équipe ${match.capVotes.A} ✅` : "—";
  const voteTxtB = match.capVotes?.B ? `Équipe ${match.capVotes.B} ✅` : "—";

  const embed = new EmbedBuilder()
    .setTitle(`Match #${matchId} — ${decided ? `Décision: Équipe ${decided}` : "En review"}`)
    .setDescription(
      decided
        ? `La décision a été **validée** par un admin.\nVictoire: **Équipe ${decided}**.`
        : `Les capitaines ne sont pas d'accord. Un admin doit trancher.`
    )
    .addFields(
      { name: "Carte", value: match.pickedMap ? `\`${match.pickedMap}\`` : "—", inline: false },
      { name: "Vote Capitaine A", value: voteTxtA, inline: true },
      { name: "Vote Capitaine B", value: voteTxtB, inline: true },
    )
    .setColor(color);

  try {
    const channel = await client.channels.fetch(match.reviewChannelId);
    const msg = await channel.messages.fetch(match.reviewMessageId);
    await msg.edit({
      embeds: [embed],
      components: decided
        ? [] // on désactive les boutons si une décision existe
        : msg.components,
    });
  } catch {}
}

/** Crée (ou récupère) le salon texte d’escalade admin */
async function ensureAdminReviewChannel(guild) {
  if (!guild) return null;
  let ch = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === "match-review"
  );
  if (ch) return ch;

  ch = await guild.channels.create({
    name: "match-review",
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ],
  });
  return ch;
}

/** Embed d’état du vote capitaine */
function captainVoteEmbed(match, state) {
  const voteA = state?.capVotes?.A ?? "—";
  const voteB = state?.capVotes?.B ?? "—";
  const txtA = voteA === "A" ? "A ✅" : voteA === "B" ? "B ✅" : "—";
  const txtB = voteB === "A" ? "A ✅" : voteB === "B" ? "B ✅" : "—";

  return new EmbedBuilder()
    .setTitle(`Match #${match.matchId} — Vote des capitaines`)
    .setDescription(
      (match.pickedMap ? `**Carte :** ${match.pickedMap}\n` : "") +
      `Seuls les **capitaines** votent.\n` +
      `• Si les 2 votes **coïncident** → victoire validée\n` +
      `• Si **désaccord** → envoi en **review admin**`
    )
    .addFields(
      { name: "Vote capitaine A", value: txtA, inline: true },
      { name: "Vote capitaine B", value: txtB, inline: true },
    );
}

/** MAJ du message #3 (bonne game + vote capitaine) */
async function updateCaptainVoteMessage(client, matchId) {
  const match = await col("matches").findOne({ matchId });
  if (!match?.voteMessageId || !match?.threadId) return;

  const fresh = await col("matches").findOne(
    { matchId },
    { projection: { capVotes: 1, pickedMap: 1 } }
  );

  const voteA = fresh?.capVotes?.A ?? "—";
  const voteB = fresh?.capVotes?.B ?? "—";
  const txtA = voteA === "A" ? "A ✅" : voteA === "B" ? "B ✅" : "—";
  const txtB = voteB === "A" ? "A ✅" : voteB === "B" ? "B ✅" : "—";

  const embed = new EmbedBuilder()
    .setTitle(`Match #${matchId} — Vote des capitaines`)
    .setDescription(
      (fresh?.pickedMap ? `**Carte :** ${fresh.pickedMap}\n` : "") +
      `Seuls les **capitaines** votent.\n` +
      `• Si les 2 votes **coïncident** → victoire validée\n` +
      `• Si **désaccord** → envoi en **review admin**`
    )
    .addFields(
      { name: "Vote capitaine A", value: txtA, inline: true },
      { name: "Vote capitaine B", value: txtB, inline: true },
    );

  try {
    const thread = await client.channels.fetch(match.threadId);
    const msg = await thread.messages.fetch(match.voteMessageId);
    await msg.edit({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`capvote_A_${matchId}`).setLabel("Équipe A a gagné").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`capvote_B_${matchId}`).setLabel("Équipe B a gagné").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
  } catch {}
}

/** Envoi vers #match-review si désaccord capitaine */
async function escalateToAdminReview(client, matchId) {
  const match = await col("matches").findOne({ matchId });
  if (!match) return;
  console.log('test');

    // 2) Désactiver les anciens boutons de vote dans le thread (si présents)
  try {
    if (match.threadId && match.voteMessageId) {
      const thread = await client.channels.fetch(match.threadId);
      const msg = await thread.messages.fetch(match.voteMessageId);
      const embeds = msg.embeds?.length ? msg.embeds : [];
      await msg.edit({ embeds, components: [] });
    }
  } catch {}

  // guild
  let guild = null;
  if (match.guildId) {
    guild = client.guilds.cache.get(match.guildId) ?? null;
    if (!guild) { try { guild = await client.guilds.fetch(match.guildId); } catch {} }
  }
  if (!guild && match.threadId) {
    try { const thread = await client.channels.fetch(match.threadId); guild = thread?.guild ?? null; } catch {}
  }
  if (!guild) return;

  const review = await ensureAdminReviewChannel(guild);
  if (!review) return;

  // Récup info utiles
  const veto = await col("veto").findOne({ matchId }, { projection: { captainA: 1, captainB: 1 } });
  const capVotes = match.capVotes ?? {};
  const voteTxtA = capVotes.A ? `Équipe ${capVotes.A} ✅` : "—";
  const voteTxtB = capVotes.B ? `Équipe ${capVotes.B} ✅` : "—";

  const embed = new EmbedBuilder()
    .setTitle(`Litige — Match #${matchId}`)
    .setDescription(
      `Les **capitaines ne sont pas d’accord** sur le vainqueur.\n` +
      `Merci à un **admin** de trancher via les boutons ci-dessous.`
    )
    .addFields(
      {
        name: "Équipe A",
        value:
          (match.teamA || []).map(id => `${id === veto?.captainA ? "👑" : "•"} <@${id}>`).join("\n") || "—",
        inline: true
      },
      {
        name: "Équipe B",
        value:
          (match.teamB || []).map(id => `${id === veto?.captainB ? "👑" : "•"} <@${id}>`).join("\n") || "—",
        inline: true
      },
      { name: "Carte", value: match.pickedMap ? `\`${match.pickedMap}\`` : "—", inline: false },
      { name: "Vote Capitaine A", value: voteTxtA, inline: true },
      { name: "Vote Capitaine B", value: voteTxtB, inline: true },
    )
    .setColor(0xF39C12) // orange "en review"
    .setFooter({ text: "Seuls les rôles autorisés peuvent valider." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_setwin_A_${matchId}`).setLabel(`Valider Équipe A`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_setwin_B_${matchId}`).setLabel(`Valider Équipe B`).setStyle(ButtonStyle.Danger),
  );

  const sent = await review.send({ embeds: [embed], components: [row] });

  // ⚠️ ne stocke QUE des IDs
  await col("matches").updateOne(
    { matchId },
    { $set: { reviewChannelId: sent.channel.id, reviewMessageId: sent.id, status: "review", updatedAt: new Date() } }
  );

  try {
  const m = await col("matches").findOne(
    { matchId },
    { projection: { guildId: 1 } }
  );
  if (m?.guildId) {
    await upsertMatchHistoryMessage(client, m.guildId, matchId);
  }
} catch (e) {
  console.warn("[history] update on dispute failed:", e?.message);
}

// juste après avoir set status: "litige"
try {
  const m = await col("matches").findOne(
    { matchId },
    { projection: { threadId: 1, recapMessageId: 1, vetoMessageId: 1, voteMessageId: 1 } }
  );
  await disableMatchComponents(client, m);
} catch {}


  // info dans le thread
  try {
    if (match.threadId) {
      const thread = await client.channels.fetch(match.threadId);
      await thread.send("⚠️ Désaccord des capitaines → **review admin** ouverte dans `#match-review`.");
    }
  } catch {}
}


/** ===== Algorithmes ===== **/
function balanceTeams(players) {
  const sorted = [...players].sort((a, b) => b.rating - a.rating);
  const teamA = [], teamB = [];
  let sumA = 0, sumB = 0;
  for (const p of sorted) {
    if (teamA.length < 5 && (sumA <= sumB || teamB.length >= 5)) {
      teamA.push(p); sumA += p.rating;
    } else {
      teamB.push(p); sumB += p.rating;
    }
  }
  return { teamA, teamB, sumA, sumB, diff: Math.abs(sumA - sumB) };
}

function expectedScore(avgA, avgB) {
  return 1 / (1 + Math.pow(10, (avgB - avgA) / 400));
}

function computeDeltas(avgA, avgB, winner, K = 24) {
  const EA = expectedScore(avgA, avgB);
  const EB = 1 - EA;
  let SA, SB;
  if (winner === "A") { SA = 1; SB = 0; }
  else if (winner === "B") { SA = 0; SB = 1; }
  else { SA = 0.5; SB = 0.5; }
  const deltaA = Math.round(K * (SA - EA)); // delta pour l'équipe A
  const deltaB = Math.round(K * (SB - EB)); // delta pour l'équipe B
  return { deltaA, deltaB };
}

/** ===== Vote UI ===== **/
function voteComponents(matchId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote_A_${matchId}`).setLabel("Vote Équipe A").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`vote_B_${matchId}`).setLabel("Vote Équipe B").setStyle(ButtonStyle.Danger),
    ),
  ];
}

/** ===== Flux principal : création du match ===== **/
export async function tryStartMatch(client) {
  const ten = await col("queue").aggregate([
    { $sort: { joinedAt: 1 } },
    { $limit: 10 },
    { $lookup: { from: "players", localField: "userId", foreignField: "userId", as: "player" } },
    { $addFields: { rating: { $ifNull: [{ $arrayElemAt: ["$player.rating", 0] }, 1000] } } },
    { $project: { userId: 1, rating: 1 } }
  ]).toArray();

  if (ten.length < 10) return;

  const { teamA, teamB } = balanceTeams(ten);
  const matchId = await getNextSequence("matchId");

  const cfg = await col("config").findOne({ _id: "queuePanel" });
  if (!cfg) return;

  const channel = await client.channels.fetch(cfg.channelId);

  // thread privé pour les 10 joueurs (rien dans le canal principal)
  const thread = await channel.threads.create({
    name: `Match #${matchId} — ${new Date().toLocaleTimeString()}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  await col("matches").insertOne({
    matchId,
    createdAt: new Date(),
    status: "voting",
    threadId: thread.id,
    queueMessageId: cfg.messageId,
  });

  const teamAIds = teamA.map(p => p.userId);
  const teamBIds = teamB.map(p => p.userId);
  const allIds = [...teamAIds, ...teamBIds];

  await col("match_players").insertMany([
    ...teamAIds.map(id => ({ matchId, userId: id, team: "A" })),
    ...teamBIds.map(id => ({ matchId, userId: id, team: "B" })),
  ]);

  // ajouter les 10 joueurs au thread privé
  for (const id of allIds) {
    try { await thread.members.add(id); } catch {}
  }

  // retirer de la file
  await col("queue").deleteMany({ userId: { $in: allIds } });

  // On récupère la guild depuis le thread ou le channel parent
  const guild =
  thread?.guild ??
  channel?.guild ??
  interaction?.guild ??
  (client.guilds && client.guilds.cache.size === 1
    ? client.guilds.cache.first()
    : null);

try {
  if (!guild) throw new Error("Guild introuvable pour créer les salons vocaux");

  const voiceInfo = await createMatchVoiceChannels(
    guild,
    matchId,        // ⬅️ on utilise matchId, pas match.matchId
    teamAIds,
    teamBIds
  );

  await col("matches").updateOne(
    { matchId },   // ⬅️ idem : filtre par matchId
    { $set: { ...voiceInfo, updatedAt: new Date() } }
  );

  // Après la création du thread :
const guildId = thread?.guild?.id ?? null;
if (guildId) {
  await col("matches").updateOne(
    { matchId },
    { $set: { guildId } }
  );
}

} catch (e) {
  console.warn(`[match ${matchId}] Impossible de créer les salons vocaux :`, e.message);
}

  // 1) recap
  const { captainA, captainB } = await computeCaptains(teamAIds, teamBIds);
  const recap = buildRecapEmbed(matchId, teamAIds, teamBIds, captainA, captainB);
  const recapMessage = await thread.send({ embeds: [recap] });

  // 2) veto
  await startVeto(client, matchId, thread.id, teamAIds, teamBIds, recapMessage.id, { captainA, captainB });

  // history message (création initiale, état "En cours")
  await upsertMatchHistoryMessage(client, channel.guildId, matchId);

  await refreshQueuePanel(client);
}

/** ===== Votes ===== **/
export async function handleVoteButton(interaction, client) {
  const id = interaction.customId;

  // ===== VOTE CAPITAINE =====
  if (id.startsWith("capvote_")) {
    // capvote_A_12  /  capvote_B_12
    const [, pick, midStr] = id.split("_");
    const matchId = parseInt(midStr, 10);
    const userId = interaction.user.id;

    await interaction.deferUpdate().catch(() => {});

    // on s’appuie sur le doc veto pour connaître les capitaines
    const veto = await col("veto").findOne({ matchId });
    if (!veto) {
      return interaction.reply({ content: "Match introuvable pour ce vote.", ephemeral: true });
    }

    let side = null;
    if (userId === veto.captainA) side = "A";
    if (userId === veto.captainB) side = "B";
    if (!side) {
      return interaction.reply({ content: "Seuls les **capitaines** peuvent voter.", ephemeral: true });
    }

    await col("matches").updateOne(
      { matchId },
      { $set: { [`capVotes.${side}`]: pick, updatedAt: new Date() } }
    );

    await updateCaptainVoteMessage(client, matchId).catch(() => {});
    await interaction.deferUpdate().catch(() => {});
    const m = await col("matches").findOne({ matchId }, { projection: { capVotes: 1 } });
    const vA = m?.capVotes?.A ?? null;
    const vB = m?.capVotes?.B ?? null;
    if (vA && vB) {
      if (vA === vB) {
        // ✅ Accord → finalise avec ta fonction existante
        // ⚠️ adapte l’appel si ta signature diffère (ex: finalizeMatch(client, matchId, vA))
        await finalizeMatch( matchId, vA, client);
      } else {
        // ❌ Désaccord → escalade admin
        await escalateToAdminReview(client, matchId);
      }
    }
    return;
  }

  // ===== DÉCISION ADMIN DANS #match-review =====
  if (id.startsWith("admin_setwin_")) {
    // admin_setwin_A_12
    const [, , pick, midStr] = id.split("_");
    const matchId = parseInt(midStr, 10);

    // Protection via rôles (configurable avec /admin_roles_set key: admin_review_pick)
    const ok = await requireRole(interaction, "admin_review_pick");
    if (!ok) return; // message d’erreur déjà envoyé

    await interaction.deferUpdate().catch(() => {});
    await finalizeMatch( matchId, pick, client);
    await updateAdminReviewMessage(client, matchId, pick).catch(() => {});

    // (optionnel) : édite le message de review pour figer la décision
    try {
      const match = await col("matches").findOne({ matchId });
      if (match?.reviewMessageId && interaction.channelId) {
        const msg = await interaction.channel.messages.fetch(match.reviewMessageId).catch(() => null);
        if (msg) await msg.edit({ content: `Décision admin: **Équipe ${pick}** validée (match #${matchId}).`, components: [] });
      }
    } catch {}
    return;
  }

  // Anciennes IDs "vote_" → on ignore (ou renvoie un msg éphémère si tu préfères)
}


/** ===== Finalisation Elo + annonces + MAJ boards ===== **/
export async function finalizeMatch(matchId, winner, client) {
  const match = await col("matches").findOne({ matchId });
  if (!match) return;

  const players = await col("match_players").aggregate([
    { $match: { matchId } },
    { $lookup: { from: "players", localField: "userId", foreignField: "userId", as: "p" } },
    { $addFields: { rating: { $ifNull: [{ $arrayElemAt: ["$p.rating", 0] }, 1000] } } },
    { $project: { userId: 1, team: 1, rating: 1 } }
  ]).toArray();

  const teamA = players.filter(p => p.team === "A");
  const teamB = players.filter(p => p.team === "B");
  const avgA = Math.round(teamA.reduce((s, p) => s + p.rating, 0) / teamA.length);
  const avgB = Math.round(teamB.reduce((s, p) => s + p.rating, 0) / teamB.length);

  const { deltaA, deltaB } = computeDeltas(avgA, avgB, winner, 24);

  // ensure
  const bulkEnsure = col("players").initializeUnorderedBulkOp();
  for (const p of players) {
    bulkEnsure.find({ userId: p.userId }).upsert().updateOne({
      $setOnInsert: {
        userId: p.userId,
        rating: 1000,
        gamesPlayed: 0,
        banned: false,
        createdAt: new Date(),
      },
      $set: { updatedAt: new Date() },
    });
  }
  if (bulkEnsure.length) await bulkEnsure.execute();

  // apply (⚠️ fixe : delta par équipe, pas “gagnant/perdant” mal mappé)
  const bulkApply = col("players").initializeUnorderedBulkOp();
  const history = [];
  for (const p of players) {
    const delta = (p.team === "A") ? deltaA : deltaB;
    const current = await col("players").findOne({ userId: p.userId }, { projection: { rating: 1 } });
    const oldRating = current?.rating ?? 1000;

    bulkApply.find({ userId: p.userId }).updateOne({
      $inc: { rating: delta, gamesPlayed: 1 },
      $set: { updatedAt: new Date() },
    });

    history.push({
      userId: p.userId,
      matchId,
      oldRating,
      newRating: oldRating + delta,
      delta,
      createdAt: new Date(),
    });
  }
  if (history.length) await col("rating_history").insertMany(history);
  if (bulkApply.length) await bulkApply.execute();

  await col("matches").updateOne({ matchId }, { $set: { status: "closed", closedAt: new Date(), winner } });

  try { await cleanupMatchAssets(client, matchId); } catch {}

  // annonce dans le thread + archive
  try {
    if (match.threadId) {
      const thread = await client.channels.fetch(match.threadId);
      if (thread?.archived) { try { await thread.setArchived(false, "Annonce résultat"); } catch {} }
      const resultEmbed = new EmbedBuilder()
        .setTitle(`Résultat — Match #${matchId}`)
        .setDescription(`**Victoire de l’équipe ${winner}**`)
        .addFields(
          { name: "Équipe A", value: teamA.map(p => `<@${p.userId}>`).join(", ") || "—" },
          { name: "Équipe B", value: teamB.map(p => `<@${p.userId}>`).join(", ") || "—" },
        );
      try { await thread.send({ embeds: [resultEmbed] }); } catch {}
      try { if (!thread.archived) await thread.setArchived(true, "Match clôturé"); } catch {}
    }
  } catch {}

  // MAJ boards
  try {
    const guildId = (await client.channels.fetch(match.threadId))?.guildId;
    if (guildId) {
      await refreshLeaderboard(client, guildId);
      await upsertMatchHistoryMessage(client, guildId, matchId);
    }
  } catch {}

  try {
  const m = await col("matches").findOne(
    { matchId },
    { projection: { threadId: 1, recapMessageId: 1, vetoMessageId: 1, voteMessageId: 1 } }
  );
  await disableMatchComponents(client, m);
} catch {}

}

export async function cleanupMatchAssets(client, matchId) {
  const match = await col("matches").findOne({ matchId });
  if (!match) return;

  // Récupère la guild via guildId sinon via le thread
  let guild = null;
  if (match.guildId) {
    guild = client.guilds.cache.get(match.guildId) ?? null;
    if (!guild) {
      try { guild = await client.guilds.fetch(match.guildId); } catch {}
    }
  }
  if (!guild && match.threadId) {
    try {
      const thread = await client.channels.fetch(match.threadId);
      guild = thread?.guild ?? null;
    } catch {}
  }

  try {
    await cleanupMatchVoiceChannels(guild, match);
  } catch {}
}


export { refreshLeaderboard, upsertMatchHistoryMessage, disableMatchComponents };
