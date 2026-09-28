// Training log: sessions and weekly notes. Private to the athlete; coaches
// only ever see the aggregates computed in services/dashboard.ts.

import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import { mondayDate } from "../lib/dates";
import type { SessionInput, WeeklyNoteInput } from "../lib/validation";

export async function addSessionFor(db: Db, userId: string, input: SessionInput) {
  const result = await db.insert(schema.trainingSessions).values({ userId, ...input }).returning({ id: schema.trainingSessions.id });
  const row = result[0];
  if (!row) throw new Error("Session could not be saved");
  return { id: row.id };
}

export async function updateSessionFor(db: Db, userId: string, id: number, input: SessionInput) {
  const result = await db.update(schema.trainingSessions).set(input)
    .where(and(eq(schema.trainingSessions.id, id), eq(schema.trainingSessions.userId, userId)));
  if (result.meta.changes === 0) return null;
  return { ok: true as const };
}

export async function deleteSessionFor(db: Db, userId: string, id: number) {
  const result = await db.delete(schema.trainingSessions)
    .where(and(eq(schema.trainingSessions.id, id), eq(schema.trainingSessions.userId, userId)));
  if (result.meta.changes === 0) return null;
  return { ok: true as const };
}

export async function saveWeeklyNoteFor(db: Db, userId: string, input: WeeklyNoteInput) {
  const weekStart = mondayDate(input.today).toISOString().slice(0, 10);
  const now = new Date();
  await db.insert(schema.weeklyNotes).values({ userId, weekStart, notes: input.notes, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [schema.weeklyNotes.userId, schema.weeklyNotes.weekStart], set: { notes: input.notes, updatedAt: now } });
  const rows = await db.select().from(schema.weeklyNotes)
    .where(and(eq(schema.weeklyNotes.userId, userId), eq(schema.weeklyNotes.weekStart, weekStart))).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Weekly note could not be saved");
  return { id: row.id, weekStart: row.weekStart, notes: row.notes, updatedAt: row.updatedAt.toISOString() };
}
