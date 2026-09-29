// Account, session and invite operations. The WebCrypto primitives and cookie
// helpers live in lib/auth.ts; this module owns the database side.
//
// D1 has no transactions: every multi-statement write that must be atomic is
// a single conditional statement or a `db.batch([...])`.

import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import { hashPassword, needsRehash, newToken, parsePasswordHash, randomId, sha256Hex, verifyPassword } from "../lib/auth";
import type { AcceptInviteInput, CredentialsInput } from "../lib/validation";
import { enqueueBlobCleanupFromAttachments } from "./cleanup";

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

/**
 * Creates a session row and returns the raw token to set as the cookie, or
 * null when the user no longer exists or is deactivated. The insert is
 * conditioned on `deactivated_at IS NULL` in the same statement, so a login
 * racing a deactivation cannot leave a session that reactivation would revive.
 */
export async function createSession(db: Db, userId: string, verifiedHash?: string): Promise<string | null> {
  const token = newToken();
  const inserted = await db.run(sql`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
    SELECT ${randomId()}, ${await sha256Hex(token)}, ${userId}, ${Date.now() + SESSION_TTL_MS}, ${Date.now()}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND deactivated_at IS NULL
      ${verifiedHash === undefined ? sql`` : sql`AND password_hash = ${verifiedHash}`})
  `);
  return inserted.meta.changes === 1 ? token : null;
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
}

/** Signs the user out everywhere: every session row, including the current one. */
export async function deleteAllSessions(db: Db, userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
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

/**
 * Verifies credentials; null when the username or password is wrong, or when
 * the stored hash is unsupported (e.g. a pre-0002 210k hash: operator reset).
 *
 * A valid hash with a supported lower iteration count is rehashed at the
 * current count after verification. The update is conditioned on the exact
 * hash that was verified, so a concurrent password change is never
 * overwritten. A losing verification fails; session creation also checks the
 * returned hash so a subsequent password change cannot create a stale session.
 */
export async function authenticate(db: Db, input: CredentialsInput): Promise<UserRow | null> {
  const user = await findUserByUsername(db, input.username);
  const parsed = user ? parsePasswordHash(user.passwordHash) : null;
  if (!user || !parsed || user.deactivatedAt) {
    // Timing mitigation: unknown usernames, deactivated accounts and
    // unsupported stored hashes burn one PBKDF2 derivation, so they cost the
    // same as a wrong password and share its generic 401.
    await hashPassword(input.password);
    return null;
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) return null;
  if (needsRehash(parsed)) {
    const upgraded = await hashPassword(input.password);
    const changed = await db
      .update(schema.users)
      .set({ passwordHash: upgraded })
      .where(and(eq(schema.users.id, user.id), eq(schema.users.passwordHash, user.passwordHash)))
      .returning({ id: schema.users.id });
    if (!changed.length) return null;
    user.passwordHash = upgraded;
  }
  return user;
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
      // Column order follows schema.users: ..., created_at, deactivated_at (NULL: active).
      db.insert(schema.users).select(sql`
        SELECT ${id}, ${input.username}, ${passwordHash}, role, 0, created_by, ${usedAt.getTime()}, NULL
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

// Account lifecycle (0002 §7) -------------------------------------------------
//
// Every guard that decides whether a change may happen (current password,
// owner status, last-coach rule, target eligibility) is re-evaluated INSIDE
// the batch as a SQL condition, so concurrent requests cannot interleave
// between a pre-read and the write. Pre-reads only pick the error message.

async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return rows[0];
}

export type ChangePasswordResult = "ok" | "wrong-password" | "stale";

/**
 * Verifies the current password, then in one batch replaces the hash
 * (conditioned on the hash that was verified) and deletes every other
 * session. `sessionId` (the caller's current session) survives. "stale" means
 * another request changed the password first; nothing was changed.
 */
export async function changePassword(
  db: Db, userId: string, sessionId: string, currentPassword: string, newPassword: string,
): Promise<ChangePasswordResult> {
  const user = await findUserById(db, userId);
  if (!user) return "stale";
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return "wrong-password";
  const newHash = await hashPassword(newPassword);
  const [updated] = await db.batch([
    db.update(schema.users)
      .set({ passwordHash: newHash })
      .where(and(eq(schema.users.id, userId), eq(schema.users.passwordHash, user.passwordHash))),
    // The new hash has a fresh random salt, so its presence proves THIS
    // batch's update landed; a stale update leaves the other sessions alone.
    db.delete(schema.sessions).where(sql`
      user_id = ${userId} AND id != ${sessionId}
        AND EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND password_hash = ${newHash})
    `),
  ]);
  return updated.meta.changes === 1 ? "ok" : "stale";
}

export type DeleteAccountStatus = "ok" | "wrong-password" | "owner" | "last-coach" | "conflict";

export interface DeleteAccountResult {
  status: DeleteAccountStatus;
  /** R2 keys of the deleted user's own file attachments (for a prompt cleanup attempt). */
  blobKeys: string[];
}

/** SQL over `users` that is true only while the account may be deleted right now. */
function deletableGuard(userId: string, verifiedHash: string) {
  return sql`id = ${userId} AND is_owner = 0 AND password_hash = ${verifiedHash}
    AND (role != 'coach' OR EXISTS (
      SELECT 1 FROM users other WHERE other.role = 'coach' AND other.deactivated_at IS NULL AND other.id != ${userId}
    ))`;
}

/**
 * Deletes the caller's account. The owner (transfer first) and the last
 * active coach are refused. One batch records the user's own attachment
 * blobs in `blob_cleanup` and deletes the user row; FKs cascade the
 * user-scoped tables and set `invited_by` / `invites.created_by` to NULL, so
 * athletes and their unexpired invites are untouched. R2 is never touched
 * here: the route attempts `attemptBlobCleanup` after the commit and the cron
 * retries whatever is left.
 */
export async function deleteAccount(db: Db, userId: string, password: string): Promise<DeleteAccountResult> {
  const user = await findUserById(db, userId);
  if (!user) return { status: "conflict", blobKeys: [] };
  if (!(await verifyPassword(password, user.passwordHash))) return { status: "wrong-password", blobKeys: [] };
  if (user.isOwner) return { status: "owner", blobKeys: [] };
  if (user.role === "coach" && (await activeCoachCount(db, userId)) === 0) return { status: "last-coach", blobKeys: [] };

  const blobRows = await db
    .select({ blobKey: schema.plannedSessionAttachments.blobKey })
    .from(schema.plannedSessionAttachments)
    .where(and(eq(schema.plannedSessionAttachments.userId, userId), sql`${schema.plannedSessionAttachments.blobKey} != ''`));
  const guard = deletableGuard(userId, user.passwordHash);
  await db.batch([
    // Selected inside the batch, so a file committed after the pre-read above
    // is still queued (the cron picks it up); guarded by the same condition
    // as the delete so a refused deletion queues nothing.
    enqueueBlobCleanupFromAttachments(
      db,
      sql`user_id = ${userId} AND EXISTS (SELECT 1 FROM users WHERE ${guard})`,
      { reason: "account-delete" },
    ),
    db.delete(schema.users).where(guard),
  ]);
  // D1 counts cascaded rows in meta.changes, so confirm by re-reading.
  const remaining = await findUserById(db, userId);
  if (!remaining) return { status: "ok", blobKeys: blobRows.map((row) => row.blobKey) };
  if (remaining.isOwner) return { status: "owner", blobKeys: [] };
  if (remaining.role === "coach" && (await activeCoachCount(db, userId)) === 0) return { status: "last-coach", blobKeys: [] };
  return { status: "conflict", blobKeys: [] };
}

/** Active (non-deactivated) coaches other than `excludeId`. */
async function activeCoachCount(db: Db, excludeId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(schema.users)
    .where(and(eq(schema.users.role, "coach"), isNull(schema.users.deactivatedAt), ne(schema.users.id, excludeId)));
  return rows[0]?.n ?? 0;
}

export type TransferOwnershipResult = "ok" | "wrong-password" | "not-owner" | "self" | "invalid-target" | "conflict";

/**
 * Moves `is_owner` from the caller to `coachId` in one batch:
 *  1. clear the caller, only while they are still owner, the verified hash is
 *     unchanged and the target is an active coach (checked by subquery);
 *  2. set the target, only if statement 1 changed a row (`changes() = 1`),
 *     no owner exists and the target is still eligible;
 *  3. restore the caller if, against expectation, nobody is owner now.
 * Statement 3 means no path can commit zero owners; the partial unique index
 * means no path can commit two. Anything but (1, 1, 0) row counts is reported
 * as a conflict, which leaves ownership exactly where it was.
 */
export async function transferOwnership(db: Db, callerId: string, coachId: string, password: string): Promise<TransferOwnershipResult> {
  const caller = await findUserById(db, callerId);
  if (!caller || !caller.isOwner) return "not-owner";
  if (coachId === callerId) return "self";
  if (!(await verifyPassword(password, caller.passwordHash))) return "wrong-password";
  const target = await findUserById(db, coachId);
  if (!target || target.role !== "coach" || target.deactivatedAt) return "invalid-target";
  const eligibleTarget = sql`EXISTS (
    SELECT 1 FROM users t WHERE t.id = ${coachId} AND t.role = 'coach' AND t.deactivated_at IS NULL AND t.id != ${callerId}
  )`;
  const [cleared, promoted, restored] = await db.batch([
    db.update(schema.users).set({ isOwner: false }).where(sql`
      id = ${callerId} AND is_owner = 1 AND password_hash = ${caller.passwordHash} AND ${eligibleTarget}
    `),
    db.update(schema.users).set({ isOwner: true }).where(sql`
      id = ${coachId} AND role = 'coach' AND deactivated_at IS NULL AND changes() = 1
        AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
        AND EXISTS (SELECT 1 FROM users c WHERE c.id = ${callerId} AND c.is_owner = 0)
    `),
    db.update(schema.users).set({ isOwner: true }).where(sql`
      id = ${callerId} AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
    `),
  ]);
  if (cleared.meta.changes === 1 && promoted.meta.changes === 1 && restored.meta.changes === 0) return "ok";
  return "conflict";
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
