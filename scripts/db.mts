/** Usage: DATABASE_URL=... npx tsx scripts/db.ts migrate|seed|reset */
import { openDb } from "../lib/server/db/client";
import { rollbackAll } from "../lib/server/db/migrate";
import { seedIfEmpty } from "../lib/server/db/seed";

const cmd = process.argv[2];
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for db scripts.");
  process.exit(1);
}
const db = await openDb({ migrate: cmd !== "reset" });
if (cmd === "seed") {
  if (process.env.ALLOW_DEMO_SEED !== "true") {
    console.error("Refusing to seed synthetic data without ALLOW_DEMO_SEED=true.");
    process.exit(1);
  }
  console.log("seeded:", await seedIfEmpty(db));
} else if (cmd === "reset") {
  if (process.env.ALLOW_DB_RESET !== "true") {
    console.error("Refusing to drop all tables without ALLOW_DB_RESET=true.");
    process.exit(1);
  }
  await rollbackAll(db);
  console.log("all tables dropped");
} else console.log("migrations applied");
await db.close();
