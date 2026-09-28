// Bow setups (gear). Private to the athlete.

import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { SetupInput } from "../lib/validation";

export function toSetup(row: typeof schema.bowSetups.$inferSelect) {
  let sightMarks: Record<string, string> = {};
  try { sightMarks = JSON.parse(row.sightMarksJson) as Record<string, string>; } catch { sightMarks = {}; }
  return { id: row.id, poundage: row.poundage, name: row.name, limbRiser: row.limbRiser, tillerBolts: row.tillerBolts,
    braceHeight: row.braceHeight, stringTwists: row.stringTwists, nockingPoint: row.nockingPoint, centerShot: row.centerShot,
    plunger: row.plunger, gripNotes: row.gripNotes, stabilizer: row.stabilizer, clickerPosition: row.clickerPosition,
    bareShaft: row.bareShaft, walkBack: row.walkBack, arrowsInUse: row.arrowsInUse, sightMarks, updatedAt: row.updatedAt.toISOString() };
}

export async function saveSetupFor(db: Db, userId: string, input: SetupInput) {
  const { id, sightMarks, ...fields } = input;
  const values = { ...fields, sightMarksJson: JSON.stringify(sightMarks), updatedAt: new Date() };
  if (id) {
    const result = await db.update(schema.bowSetups).set(values)
      .where(and(eq(schema.bowSetups.id, id), eq(schema.bowSetups.userId, userId)));
    if (result.meta.changes === 0) return null;
    return { id };
  }
  const result = await db.insert(schema.bowSetups).values({ userId, ...values }).returning({ id: schema.bowSetups.id });
  const row = result[0];
  if (!row) throw new Error("Setup could not be saved");
  return { id: row.id };
}

export async function duplicateSetupFor(db: Db, userId: string, id: number, poundage: number) {
  const rows = await db.select().from(schema.bowSetups)
    .where(and(eq(schema.bowSetups.id, id), eq(schema.bowSetups.userId, userId))).limit(1);
  const source = rows[0];
  if (!source) return null;
  const { id: _id, userId: _userId, updatedAt: _updatedAt, ...copy } = source;
  const result = await db.insert(schema.bowSetups)
    .values({ ...copy, userId, poundage, name: `${poundage} lb setup`, updatedAt: new Date() })
    .returning({ id: schema.bowSetups.id });
  const row = result[0];
  if (!row) throw new Error("Setup could not be duplicated");
  return { id: row.id };
}
