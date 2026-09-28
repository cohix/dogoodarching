// The deployment-wide team: every coach shares every athlete.

import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "../db";

export async function listCoaches(db: Db) {
  const rows = await db
    .select({ id: schema.users.id, username: schema.users.username, isOwner: schema.users.isOwner, createdAt: schema.users.createdAt })
    .from(schema.users).where(eq(schema.users.role, "coach")).orderBy(asc(schema.users.username));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function listAthletes(db: Db) {
  const rows = await db
    .select({ id: schema.users.id, username: schema.users.username, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.role, "athlete"))
    .orderBy(asc(schema.users.username));
  return rows.map((row) => ({ id: row.id, username: row.username, createdAt: row.createdAt.toISOString() }));
}
