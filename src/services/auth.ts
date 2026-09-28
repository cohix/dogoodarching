// Account, session and invite operations. The WebCrypto primitives and cookie
// helpers live in lib/auth.ts; this module owns the database side.
//
// D1 has no transactions: every multi-statement write that must be atomic is
// a single conditional statement or a `db.batch([...])`.

import { and, count, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import { hashPassword, newToken, randomId, sha256Hex, verifyPassword } from "../lib/auth";
import type { AcceptInviteInput, CredentialsInput } from "../lib/validation";

const SESSION_TTL_MS = 30 * 86400 * 1000;
/** Magic-link invites expire exactly 24 hours after creation, per owner requirement. */
export const INVITE_TTL_HOURS = 24;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 3600 * 1000;

export type UserRow = typeof schema.users.$inferSelect;

export type PublicUser = { id: string; username: string; role: UserRow["role"]; isOwner: boolean };

export function publicUser(user: Pick<UserRow, "id" | "username" | "role" | "isOwner">): PublicUser {
  return { id: user.id, username: user.username, role: user.role, isOwner: user.isOwner };
}

async function findUserByUsername(db: Db, username: string): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return rows[0];
}

/** True when the error is a SQLite/D1 UNIQUE constraint failure. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unique constraint failed/i.test(error.message) || isUniqueViolation(error.cause);
}

// Sessions -------------------------------------------------------------------

/** Creates a session row and returns the raw token to set as the cookie. */
export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newToken();
  await db.insert(schema.sessions).values({
    id: randomId(),
    tokenHash: await sha256Hex(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    createdAt: new Date(),
  });
  return token;
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
}

// Accounts -------------------------------------------------------------------

export async function userCount(db: Pick<Db, "select">): Promise<number> {
  const rows = await db.select({ n: count() }).from(schema.users);
  return rows[0]?.n ?? 0;
}

/**
 * Creates the first account (the owner coach). One conditional INSERT, so
 * concurrent bootstraps produce exactly one winner. Returns null when an
 * account already exists.
 */
export async function bootstrapOwner(db: Db, input: CredentialsInput): Promise<PublicUser | null> {
  const id = randomId();
  const passwordHash = await hashPassword(input.password);
  const inserted = await db.run(sql`
    INSERT INTO users (id, username, password_hash, role, is_owner, created_at)
    SELECT ${id}, ${input.username}, ${passwordHash}, 'coach', 1, ${Date.now()}
    WHERE NOT EXISTS (SELECT 1 FROM users)
  `);
  if (inserted.meta.changes !== 1) return null;
  return { id, username: input.username, role: "coach", isOwner: true };
}

/** Verifies credentials; null when the username or password is wrong. */
export async function authenticate(db: Db, input: CredentialsInput): Promise<UserRow | null> {
  const user = await findUserByUsername(db, input.username);
  // Timing mitigation: burn an equivalent PBKDF2 for unknown usernames so
  // the failure path costs the same as the password-check path.
  const hashToCheck = user?.passwordHash ?? (await hashPassword(input.password));
  const ok = user !== undefined && (await verifyPassword(input.password, hashToCheck));
  return ok ? (user as UserRow) : null;
}

export type AcceptInviteResult =
  | { status: "ok"; user: PublicUser }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "not-claimable" }
  | { status: "username-taken" };

/**
 * Claims an invite and creates the user in one batch. The batch is atomic, so
 * a username UNIQUE violation also rolls back the claim. Coach invites are
 * only valid while their creator is still the owner.
 */
export async function acceptInvite(db: Db, input: AcceptInviteInput): Promise<AcceptInviteResult> {
  const inviteRows = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.tokenHash, await sha256Hex(input.token)))
    .limit(1);
  const invite = inviteRows[0];
  if (!invite) return { status: "unknown" };
  if (invite.usedAt || invite.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  const id = randomId();
  const passwordHash = await hashPassword(input.password);
  const usedAt = new Date();
  // Check expiry at database execution time as well as submission time.
  // Check coach-invite authority inside the batch, including after any owner deletion.
  const validCreator = sql`(role = 'athlete' OR EXISTS (
    SELECT 1 FROM users WHERE users.id = invites.created_by AND users.is_owner = 1
  ))`;
  try {
    const [claimed, inserted] = await db.batch([
      db.update(schema.invites).set({ usedAt }).where(sql`
        id = ${invite.id} AND used_at IS NULL AND expires_at > ${usedAt.getTime()}
        AND expires_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000
          + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))
        AND ${validCreator}
      `),
      // changes() ties the insert to THIS batch's claim even if two requests
      // choose the same millisecond. A UNIQUE failure rolls back both statements.
      db.insert(schema.users).select(sql`
        SELECT ${id}, ${input.username}, ${passwordHash}, role, 0, created_by, ${usedAt.getTime()}
        FROM invites WHERE id = ${invite.id} AND changes() = 1 AND EXISTS (
          SELECT 1 FROM invites WHERE id = ${invite.id} AND used_at = ${usedAt.getTime()}
            AND ${validCreator}
        )
      `),
    ]);
    if (claimed.meta.changes !== 1 || inserted.meta.changes !== 1) return { status: "not-claimable" };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "username-taken" };
    throw error;
  }
  return { status: "ok", user: { id, username: input.username, role: invite.role, isOwner: false } };
}

// Invites --------------------------------------------------------------------

export type InviteViewer = { id: string; isOwner: boolean };

/** Creates a single-use invite and returns the raw token for the magic link. */
export async function createInvite(db: Db, createdBy: string, role: "athlete" | "coach"): Promise<string> {
  const token = newToken();
  await db.insert(schema.invites).values({
    id: randomId(),
    tokenHash: await sha256Hex(token),
    createdBy,
    role,
    // Invites always expire exactly 24 hours after creation; the expiry is
    // not caller-configurable.
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    usedAt: null,
    createdAt: new Date(),
  });
  return token;
}

/** Owner: all invitations. Other coaches: their own (never token hashes). Instants are epoch ms. */
export async function listInvites(db: Db, viewer: InviteViewer) {
  const rows = await db.select().from(schema.invites).where(viewer.isOwner ? undefined : eq(schema.invites.createdBy, viewer.id));
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt.getTime(),
    usedAt: row.usedAt ? row.usedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  }));
}

/** Owner: revoke any invitation. Other coaches: only their own. False when nothing matched. */
export async function revokeInvite(db: Db, viewer: InviteViewer, inviteId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.invites)
    .where(and(eq(schema.invites.id, inviteId), viewer.isOwner ? undefined : eq(schema.invites.createdBy, viewer.id)));
  const changes = (deleted as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes === 1;
}
