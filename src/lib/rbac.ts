import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq, gt } from "drizzle-orm";
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

/** Requires a valid, unexpired session cookie; loads the user or 401s. */
export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const token = getSessionToken(c.req.raw);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb(c.env.DB);
  const tokenHash = await sha256Hex(token);
  const sessionRows = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, Date.now())))
    .limit(1);
  const session = sessionRows[0];
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
  const user = userRows[0];
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", {
    id: user.id,
    username: user.username,
    role: user.role,
    coachId: user.coachId,
    createdAt: user.createdAt,
  });
  c.set("sessionId", session.id);
  await next();
});

/** Requires the authenticated user to be a coach; otherwise 403. */
export const requireCoach = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get("user").role !== "coach") return c.json({ error: "Forbidden" }, 403);
  await next();
});

/**
 * Loads an athlete that belongs to the calling coach's team.
 * Returns null (caller should 404) unless the athlete exists AND
 * has role='athlete' AND coach_id = coach.id.
 */
export async function resolveAthlete(c: Context<AppBindings>, athleteId: string): Promise<AuthUser | null> {
  const coach = c.get("user");
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, athleteId),
        eq(schema.users.role, "athlete"),
        eq(schema.users.coachId, coach.id),
      ),
    )
    .limit(1);
  const athlete = rows[0];
  if (!athlete) return null;
  return {
    id: athlete.id,
    username: athlete.username,
    role: athlete.role,
    coachId: athlete.coachId,
    createdAt: athlete.createdAt,
  };
}
