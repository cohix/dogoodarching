// Inspiration entries (thought, video, recipe). Private to the athlete.

import { schema, type Db } from "../db";
import type { InspirationInput } from "../lib/validation";

export async function addInspirationFor(db: Db, userId: string, input: InspirationInput) {
  const updatedAt = new Date();
  await db.insert(schema.inspirationEntries).values({ userId, ...input, updatedAt });
  return { ...input, updatedAt: updatedAt.toISOString() };
}
