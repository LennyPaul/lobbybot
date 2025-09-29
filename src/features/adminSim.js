// src/features/adminSim.js
import { col } from "../db/models.js";
import {
  refreshQueuePanel,
  maybeLaunchReadyCheckOrStart,
} from "./queuePanel.js";

/**
 * /fill
 * Options:
 * - count (int, défaut 10)
 * - use_fakes (bool, défaut true) → complète avec des faux joueurs si pas assez de membres humains
 * - auto_confirm_fakes (bool, défaut false) → pendant un ready-check, confirme automatiquement tous les fakes
 *
 * Remarques:
 * - Les faux joueurs ont un userId au format "f_<nombre>" et un champ { fake: true }.
 * - Ils sont insérés dans players + queue.
 * - Si auto_confirm_fakes=true et qu'un ready-check est en cours après le fill,
 *   on ajoute immédiatement tous les fakes présents dans ce RC à confirmedIds.
 */
export async function handleFill(interaction, client) {
  const count = interaction.options.getInteger("count") ?? 10;
  const useFakes = interaction.options.getBoolean("use_fakes") ?? true;
  const autoConfirmFakes =
    interaction.options.getBoolean("auto_confirm_fakes") ?? false;

  const now = new Date();
  let added = 0;

  // 1) Tenter avec des membres du serveur (non-bots)
  const guild = interaction.guild;
  let pool = [];
  try {
    const members = await guild.members.fetch();
    pool = [...members.values()].filter((m) => !m.user.bot);
  } catch {}
  // Ajoute des membres réels manquants
  for (const m of pool) {
    if (added >= count) break;
    const userId = m.id;

    // Déjà en file ?
    const exists = await col("queue").findOne({ userId });
    if (exists) continue;

    // En match actif ?
    const active = await col("match_players")
      .aggregate([
        { $match: { userId } },
        {
          $lookup: {
            from: "matches",
            localField: "matchId",
            foreignField: "matchId",
            as: "m",
          },
        },
        { $unwind: "$m" },
        { $match: { "m.status": { $nin: ["closed", "reversed", "abandoned"] } } },
        { $limit: 1 },
      ])
      .toArray();
    if (active.length) continue;

    await col("players").updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          rating: 100,
          gamesPlayed: 0,
          banned: false,
          fake: false,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );
    await col("queue").insertOne({ userId, joinedAt: new Date(now.getTime() + added) });
    added++;
  }

  // 2) Compléter avec des fakes si besoin
  if (useFakes && added < count) {
    const toAdd = count - added;

    // cherche le plus grand index de fake existant pour éviter collisions
    const lastFake = await col("players")
      .find({ fake: true, userId: /^f_\d+$/ })
      .project({ userId: 1 })
      .toArray();
    let maxIdx = 0;
    for (const p of lastFake) {
      const n = Number(p.userId?.split("_")[1]);
      if (Number.isFinite(n)) maxIdx = Math.max(maxIdx, n);
    }

    for (let i = 1; i <= toAdd; i++) {
      const fakeId = `f_${maxIdx + i}`;

      // déjà en file ?
      const exists = await col("queue").findOne({ userId: fakeId });
      if (exists) continue;

      await col("players").updateOne(
        { userId: fakeId },
        {
          $setOnInsert: {
            userId: fakeId,
            rating: 100,
            gamesPlayed: 0,
            banned: false,
            fake: true,
            username: `Fake#${maxIdx + i}`,
            createdAt: now,
          },
          $set: { updatedAt: now },
        },
        { upsert: true }
      );
      await col("queue").insertOne({
        userId: fakeId,
        joinedAt: new Date(now.getTime() + added + i),
      });
    }
    added += toAdd;
  }

  await interaction.reply({
    content: `File remplie (+${added}). ${
      useFakes ? "(fakes autorisés)" : ""
    }`,
    ephemeral: true,
  });

  // Rafraîchir le panneau et lancer ready-check si 10+
  await refreshQueuePanel(client);
  await maybeLaunchReadyCheckOrStart(client);

  // Auto-confirmer les fakes si demandé
  if (autoConfirmFakes) {
    const rc = await col("ready_checks").findOne({ status: "pending" });
    if (rc) {
      const fakeIds = rc.userIds.filter((u) => u.startsWith("f_"));
      if (fakeIds.length) {
        await col("ready_checks").updateOne(
          { rcId: rc.rcId, status: "pending" },
          { $addToSet: { confirmedIds: { $each: fakeIds } }, $set: { updatedAt: new Date() } }
        );
        // MAJ UI
        try {
          await refreshQueuePanel(client);
        } catch {}
        // Si tout le monde est confirmé → la suite (completeReadyCheck) sera déclenchée par
        // le code existant quand le dernier vrai joueur confirmera,
        // ou on peut forcer si c’est vraiment 10/10 déjà :
        const updated = await col("ready_checks").findOne({ rcId: rc.rcId });
        if (
          updated &&
          updated.userIds.every((u) => updated.confirmedIds.includes(u))
        ) {
          // On reproduit l'appel interne sans import circulaire : petit duplicata minimal
          // → prioriser ces 10 en tête de file puis lancer le match
          const base = new Date("2000-01-01T00:00:00.000Z").getTime();
          const bulk = col("queue").initializeUnorderedBulkOp();
          updated.userIds.forEach((u, idx) => {
            bulk.find({ userId: u }).updateOne({ $set: { joinedAt: new Date(base + idx) } });
          });
          try {
            if (bulk.length) await bulk.execute();
          } catch {}

          await col("ready_checks").updateOne(
            { rcId: updated.rcId },
            { $set: { status: "complete", endedAt: new Date() } }
          );

          // refresh + démarrer match
          try { await refreshQueuePanel(client); } catch {}
          try { 
            const { tryStartMatch } = await import("./matchFlow.js");
            await tryStartMatch(client);
          } catch {}
        }
      }
    }
  }
}

/** Nettoie la file rapidement */
export async function handleClearQueue(interaction, client) {
  await col("queue").deleteMany({});
  await col("ready_checks").deleteMany({ status: "pending" });
  await interaction.reply({ content: "File vidée.", ephemeral: true });
  await refreshQueuePanel(client);
}
