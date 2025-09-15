// src/db/models.js
import { z } from "zod";
import { getDb } from "./mongo.js";

export function col(name) {
  return getDb().collection(name);
}

/**
 * Génère un identifiant auto-incrémenté pour les matchs.
 * Correction: on n'utilise PLUS $setOnInsert sur "seq" pour éviter
 * le conflit avec $inc. $inc crée le champ s'il n'existe pas (valeur 0 -> +1).
 */
export async function getNextSequence(seqName = "matchId") {
  const counters = col("counters");

  const res = await counters.findOneAndUpdate(
    { _id: seqName },
    {
      // IMPORTANT: pas de $setOnInsert sur "seq" ici
      $inc: { seq: 1 },
      $setOnInsert: { _id: seqName, createdAt: new Date() },
    },
    {
      upsert: true,
      returnDocument: "after",
    }
  );

  // Sécurisation si jamais value est null sur certains environnements
  const value = res?.value;
  if (!value || typeof value.seq !== "number") {
    const doc = await counters.findOne({ _id: seqName });
    if (doc && typeof doc.seq === "number") return doc.seq;
    // Dernier filet de sécurité : initialise à 1
    await counters.updateOne(
      { _id: seqName },
      { $set: { seq: 1 }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    return 1;
  }

  return value.seq;
}

/* =======================
   Schémas de validation
   ======================= */

export const PlayerSchema = z.object({
  userId: z.string(),
  rating: z.number().int().default(1000),
  gamesPlayed: z.number().int().default(0),
  banned: z.boolean().default(false),
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export const QueueEntrySchema = z.object({
  userId: z.string(),
  joinedAt: z.date().default(() => new Date()),
});

export const MatchSchema = z.object({
  matchId: z.number().int(),
  createdAt: z.date().default(() => new Date()),
  status: z.enum(["pending", "voting", "closed", "invalid"]).default("pending"),
  queueMessageId: z.string().optional(),
  threadId: z.string().optional(),
});

export const MatchPlayerSchema = z.object({
  matchId: z.number().int(),
  userId: z.string(),
  team: z.enum(["A", "B"]),
});

export const VoteSchema = z.object({
  matchId: z.number().int(),
  userId: z.string(),
  choice: z.enum(["A", "B"]),
  createdAt: z.date().default(() => new Date()),
});

export const RatingHistorySchema = z.object({
  userId: z.string(),
  matchId: z.number().int(),
  oldRating: z.number().int(),
  newRating: z.number().int(),
  delta: z.number().int(),
  createdAt: z.date().default(() => new Date()),
});
