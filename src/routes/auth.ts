import { Hono } from "hono";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "../db";
import { authMiddleware, requireCoach, type AppBindings } from "../lib/rbac";
import { clientIp, rateLimitOr429 } from "../lib/rate-limit";
import {
  clearSessionCookieHeader,
  getSessionToken,
  hashPassword,
  isSecureRequest,
  newToken,
  randomId,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "../lib/auth";
import { readJsonBody, zodErrorMessage } from "./tracker";

const SESSION_TTL_MS = 30 * 86400 * 1000;
/** Magic-link invites expire exactly 24 hours after creation, per owner requirement. */
const INVITE_TTL_MS = 24 * 3600 * 1000;

const usernameSchema = z.string().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, {
  message: "Username must be 3-32 characters: letters, numbers, _ or -",
});
// Max length bounds PBKDF2 input so a multi-megabyte password can't burn CPU.
const passwordSchema = z.string().min(8, { message: "Password must be at least 8 characters" }).max(128, {
  message: "Password must be at most 128 characters",
});

const credentialsInput = z.object({ username: usernameSchema, password: passwordSchema });
const acceptInviteInput = z.object({
  token: z.string().min(1),
  username: usernameSchema,
  password: passwordSchema,
});

type UserRow = typeof schema.users.$inferSelect;

function publicUser(user: Pick<UserRow, "id" | "username" | "role" | "coachId">) {
  return { id: user.id, username: user.username, role: user.role, coachId: user.coachId };
}

async function findUserByUsername(db: Db, username: string): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return rows[0];
}

async function createSession(db: Db, userId: string): Promise<string> {
  const token = newToken();
  await db.insert(schema.sessions).values({
    id: randomId(),
    tokenHash: await sha256Hex(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    createdAt: new Date(),
  });
  return token;
}

async function userCount(db: Pick<Db, "select">): Promise<number> {
  const rows = await db.select({ n: count() }).from(schema.users);
  return rows[0]?.n ?? 0;
}

/** True when the error is a SQLite/D1 UNIQUE constraint failure. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

const auth = new Hono<AppBindings>();

// Public: no session required -----------------------------------------------

auth.get("/status", async (c) => {
  const setupRequired = (await userCount(getDb(c.env.DB))) === 0;
  return c.json({ setupRequired });
});

auth.post("/bootstrap", async (c) => {
  const rl = await rateLimitOr429(c, `bootstrap:${clientIp(c)}`, 10, 3600 * 1000);
  if (rl) return rl;
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = credentialsInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  const id = randomId();
  const passwordHash = await hashPassword(parsed.data.password);
  // Race-safe: the "no users yet" check and the insert run inside one
  // transaction. If two concurrent bootstraps collide, the second sees the
  // first row (or trips a UNIQUE violation) and gets a 409.
  try {
    await getDb(c.env.DB).transaction(async (tx) => {
      const n = await userCount(tx);
      if (n > 0) throw new Error("setup-conflict");
      await tx.insert(schema.users).values({
        id,
        username: parsed.data.username,
        passwordHash,
        role: "coach",
        coachId: null,
        createdAt: new Date(),
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "setup-conflict") {
      return c.json({ error: "Setup already completed" }, 409);
    }
    if (isUniqueViolation(error)) return c.json({ error: "Setup already completed" }, 409);
    throw error;
  }
  const token = await createSession(getDb(c.env.DB), id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json({ id, username: parsed.data.username, role: "coach" }, 201);
});

auth.post("/login", async (c) => {
  const rl = await rateLimitOr429(c, `login:${clientIp(c)}`, 20, 10 * 60 * 1000);
  if (rl) return rl;
  const db = getDb(c.env.DB);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = credentialsInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  const user = await findUserByUsername(db, parsed.data.username);
  // Timing mitigation: burn an equivalent PBKDF2 for unknown usernames so
  // the failure path costs the same as the password-check path.
  const hashToCheck = user?.passwordHash ?? (await hashPassword(parsed.data.password));
  const ok = user !== undefined && (await verifyPassword(parsed.data.password, hashToCheck));
  if (!ok) return c.json({ error: "Invalid username or password" }, 401);
  const authed = user as UserRow;
  const token = await createSession(db, authed.id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json(publicUser(authed));
});

auth.post("/accept-invite", async (c) => {
  const rl = await rateLimitOr429(c, `accept-invite:${clientIp(c)}`, 20, 10 * 60 * 1000);
  if (rl) return rl;
  const db = getDb(c.env.DB);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = acceptInviteInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  const inviteRows = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.tokenHash, await sha256Hex(parsed.data.token)))
    .limit(1);
  const invite = inviteRows[0];
  if (!invite) return c.json({ error: "Invalid invite" }, 400);
  if (invite.usedAt || invite.expiresAt <= Date.now()) {
    return c.json({ error: "Invite has expired or already been used" }, 410);
  }
  const coachRows = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.id, invite.coachId), eq(schema.users.role, "coach"))).limit(1);
  if (!coachRows[0]) return c.json({ error: "Invite is no longer valid" }, 400);
  if (await findUserByUsername(db, parsed.data.username)) {
    return c.json({ error: "Username is taken" }, 409);
  }
  const id = randomId();
  const passwordHash = await hashPassword(parsed.data.password);
  // Atomic single-use claim: the conditional UPDATE only succeeds when the
  // invite is still unused. If two requests race, exactly one wins; the
  // loser rolls back its just-created user and gets a 410.
  const usedAt = Date.now();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.users).values({
        id,
        username: parsed.data.username,
        passwordHash,
        role: "athlete",
        coachId: invite.coachId,
        createdAt: new Date(),
      });
      const claimed = await tx.run(
        sql`UPDATE invites SET used_at = ${usedAt} WHERE id = ${invite.id} AND used_at IS NULL`,
      );
      if (claimed.meta.changes !== 1) throw new Error("invite-race");
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invite-race") {
      return c.json({ error: "Invite has expired or already been used" }, 410);
    }
    if (isUniqueViolation(error)) return c.json({ error: "Username is taken" }, 409);
    throw error;
  }
  const token = await createSession(db, id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json({ id, username: parsed.data.username, role: "athlete" }, 201);
});

// Authenticated --------------------------------------------------------------

auth.post("/logout", authMiddleware, async (c) => {
  const token = getSessionToken(c.req.raw);
  if (token) {
    await getDb(c.env.DB)
      .delete(schema.sessions)
      .where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
  }
  c.header("Set-Cookie", clearSessionCookieHeader(isSecureRequest(c.req.raw)));
  return c.json({ ok: true });
});

auth.get("/me", authMiddleware, async (c) => {
  return c.json(publicUser(c.get("user")));
});

auth.post("/invites", authMiddleware, requireCoach, async (c) => {
  const rl = await rateLimitOr429(c, `invite-create:${c.get("user").id}`, 20, 3600 * 1000);
  if (rl) return rl;
  const db = getDb(c.env.DB);
  const token = newToken();
  await db.insert(schema.invites).values({
    id: randomId(),
    tokenHash: await sha256Hex(token),
    coachId: c.get("user").id,
    // Invites always expire exactly 24 hours after creation; the expiry is
    // not caller-configurable.
    expiresAt: Date.now() + INVITE_TTL_MS,
    usedAt: null,
    createdAt: new Date(),
  });
  return c.json({ token, invitePath: `/invite/${token}`, expiresInHours: 24 }, 201);
});

// Coach-only: list the calling coach's own invitations (never token hashes).
auth.get("/invites", authMiddleware, requireCoach, async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(schema.invites).where(eq(schema.invites.coachId, c.get("user").id));
  return c.json(rows.map((row) => ({
    id: row.id,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt ? row.usedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  })));
});

// Coach-only: revoke one of the calling coach's own invitations.
auth.delete("/invites/:id", authMiddleware, requireCoach, async (c) => {
  const db = getDb(c.env.DB);
  const deleted = await db
    .delete(schema.invites)
    .where(and(eq(schema.invites.id, c.req.param("id")), eq(schema.invites.coachId, c.get("user").id)));
  const changes = (deleted as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes !== 1) return c.json({ error: "Invite not found" }, 404);
  return c.json({ ok: true });
});

export default auth;
