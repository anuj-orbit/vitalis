import pg from "pg";
import { MongoClient } from "mongodb";

let pgPool;
let mongoClient;

export function getPg() {
  if (!process.env.DATABASE_URL) return null;
  pgPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pgPool;
}

export async function getMongoDb() {
  if (!process.env.MONGODB_URI) return null;
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
    await mongoClient.connect();
  }
  return mongoClient.db();
}

export async function dbStatus() {
  const status = { postgres: "not_configured", mongo: "not_configured" };
  const pool = getPg();
  if (pool) {
    try {
      await pool.query("select 1");
      status.postgres = "connected";
    } catch {
      status.postgres = "error";
    }
  }
  if (process.env.MONGODB_URI) {
    try {
      const db = await getMongoDb();
      await db.command({ ping: 1 });
      status.mongo = "connected";
    } catch {
      status.mongo = "error";
    }
  }
  return status;
}

export async function withPgTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
