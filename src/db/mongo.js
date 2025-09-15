import { MongoClient } from "mongodb";
import "dotenv/config";

let client;
let db;

export async function connectMongo() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "valorant_customs";
  if (!uri) throw new Error("MONGODB_URI manquant dans .env");

  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);

  await Promise.all([
    db.collection("players").createIndex({ userId: 1 }, { unique: true }),
    db.collection("queue").createIndex({ userId: 1 }, { unique: true }),
    db.collection("queue").createIndex({ joinedAt: 1 }),
    db.collection("matches").createIndex({ status: 1 }),
    db.collection("votes").createIndex({ matchId: 1, userId: 1 }, { unique: true }),
    // ❌ ne pas créer d'index sur _id dans "config"
  ]);

  return db;
}

export function getDb() {
  if (!db) throw new Error("MongoDB non connecté. Appelle connectMongo() d’abord.");
  return db;
}

