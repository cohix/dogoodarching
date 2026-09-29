// The deployment-wide team: every coach shares every athlete. Athletes can be
// deactivated by any coach (0002 §7): they keep their data and username, lose
// login, and leave the default roster until reactivated.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "../db";

export async function listCoaches(db: Db) {
  const rows = await db
    .select({ id: schema.users.id, username: schema.users.username, isOwner: schema.users.isOwner, createdAt: schema.users.createdAt })
    .from(schema.users).where(eq(schema.users.role, "coach")).orderBy(asc(schema.users.username));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export interface AthleteSummary {
  id: string;
  username: string;
  createdAt: string;
  /** ISO instant while deactivated, null while active. */
  deactivatedAt: string | null;
}

/** Active athletes by default; `includeDeactivated` adds deactivated ones, flagged by `deactivatedAt`. */
export async function listAthletes(db: Db, options: { includeDeactivated?: boolean } = {}): Promise<AthleteSummary[]> {
  const rows = await db
    .select({
      id: schema.users.id, username: schema.users.username, createdAt: schema.users.createdAt, deactivatedAt: schema.users.deactivatedAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.role, "athlete"), options.includeDeactivated ? undefined : isNull(schema.users.deactivatedAt)))
    .orderBy(asc(schema.users.username));
  return rows.map(toSummary);
}

function toSummary(row: { id: string; username: string; createdAt: Date; deactivatedAt: Date | null }): AthleteSummary {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
  };
}

async function athleteSummary(db: Db, athleteId: string): Promise<AthleteSummary | null> {
  const rows = await db
    .select({
      id: schema.users.id, username: schema.users.username, createdAt: schema.users.createdAt, deactivatedAt: schema.users.deactivatedAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.id, athleteId), eq(schema.users.role, "athlete")))
    .limit(1);
  const row = rows[0];
  return row ? toSummary(row) : null;
}

/**
 * Marks the athlete deactivated and revokes every session in one batch.
 * Idempotent: an already deactivated athlete keeps their original timestamp.
 * Null when there is no athlete with that id (coaches never match).
 */
export async function deactivateAthlete(db: Db, athleteId: string): Promise<AthleteSummary | null> {
  await db.batch([
    db.update(schema.users).set({ deactivatedAt: new Date() }).where(sql`
      id = ${athleteId} AND role = 'athlete' AND deactivated_at IS NULL
    `),
    db.delete(schema.sessions).where(sql`
      user_id = ${athleteId} AND EXISTS (SELECT 1 FROM users WHERE id = ${athleteId} AND role = 'athlete')
    `),
  ]);
  return athleteSummary(db, athleteId);
}

/** Clears the deactivation; idempotent for an active athlete. Null when no such athlete. */
export async function reactivateAthlete(db: Db, athleteId: string): Promise<AthleteSummary | null> {
  await db.run(sql`UPDATE users SET deactivated_at = NULL WHERE id = ${athleteId} AND role = 'athlete'`);
  return athleteSummary(db, athleteId);
}
