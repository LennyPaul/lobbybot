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
  if (!id.startsWith("vote_")) return false;

  const [, team, matchIdStr] = id.split("_");
  const matchId = parseInt(matchIdStr, 10);
  const userId = interaction.user.id;

  const match = await col("matches").findOne({ matchId, status: "voting" });
  if (!match) {
    return interaction.reply({ content: "Ce vote n’est pas (ou plus) actif.", ephemeral: true });
  }

  const mp = await col("match_players").findOne({ matchId, userId });
  if (!mp) {
    return interaction.reply({ content: "Tu ne fais pas partie de ce match.", ephemeral: true });
  }

  await col("votes").updateOne(
    { matchId, userId },
    { $set: { matchId, userId, choice: team === "A" ? "A" : "B", createdAt: new Date() } },
    { upsert: true }
  );

  await interaction.deferUpdate().catch(() => {});

  // MAJ du message de vote (compteurs)
  const votes = await col("votes").aggregate([
    { $match: { matchId } },
    { $group: { _id: "$choice", n: { $sum: 1 } } }
  ]).toArray();
  const countA = votes.find(v => v._id === "A")?.n ?? 0;
  const countB = votes.find(v => v._id === "B")?.n ?? 0;
  const total = countA + countB;

  if (match.votesMessageId && match.threadId) {
    try {
      const thread = await client.channels.fetch(match.threadId);
      const msg = await thread.messages.fetch(match.votesMessageId);
      await msg.edit({
        content:
          `**Bonne game à tous !** 🎮\n` +
          `À la fin du match, merci de **voter** pour l’équipe gagnante ci-dessous.\n` +
          `> Majorité requise : **6/10** votes pour la même équipe.\n` +
          `> Elo mis à jour automatiquement.\n\n` +
          `**Votes** — Total: **${total}/10** | A: **${countA}** | B: **${countB}**`,
      });
    } catch {}
  }

  if (total >= 6 && (countA >= 6 || countB >= 6)) {
    const winner = countA > countB ? "A" : "B";
    await finalizeMatch(matchId, winner, client);
  }

  return true;
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
}

export { refreshLeaderboard, upsertMatchHistoryMessage };
