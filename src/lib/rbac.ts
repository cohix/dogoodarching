import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema, type Env } from "../db";
import { getSessionToken, sha256Hex, type AuthUser } from "./auth";

export interface AuthedVariables {
  user: AuthUser;
  sessionId: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: AuthedVariables;
};

/**
 * Requires a valid, unexpired session cookie for an active (not deactivated)
 * user; loads the user or 401s. Deactivation deletes the athlete's sessions,
 * and this check also covers a session that a racing login might have
 * created before that delete ran.
 */
export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const token = getSessionToken(c.req.raw);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb(c.env.DB);
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({ sessionId: schema.sessions.id, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(
      eq(schema.sessions.tokenHash, tokenHash),
      gt(schema.sessions.expiresAt, new Date()),
      isNull(schema.users.deactivatedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "Unauthorized" }, 401);
  const { user } = row;
  c.set("user", {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: user.isOwner,
    createdAt: user.createdAt,
  });
  c.set("sessionId", row.sessionId);
  await next();
});

/** Requires the authenticated user to be a coach; otherwise 403. */
export const requireCoach = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get("user").role !== "coach") return c.json({ error: "Forbidden" }, 403);
  await next();
});

/** Loads an athlete in the deployment-wide team; coach routes enforce requireCoach. */
export async function resolveAthlete(c: Context<AppBindings>, athleteId: string): Promise<AuthUser | null> {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, athleteId),
        eq(schema.users.role, "athlete"),
      ),
    )
    .limit(1);
  const athlete = rows[0];
  if (!athlete) return null;
  return {
    id: athlete.id,
    username: athlete.username,
    role: athlete.role,
    isOwner: athlete.isOwner,
    createdAt: athlete.createdAt,
  };
}
