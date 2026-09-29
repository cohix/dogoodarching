// Auth endpoints: bootstrap, login, logout, invites and the account lifecycle
// (password change, logout-all, deletion, ownership transfer). Handlers only;
// the account/session/invite logic lives in services/auth.ts.

import { Hono, type Context } from "hono";
import { getDb } from "../db";
import { clearSessionCookieHeader, getSessionToken, isSecureRequest, sessionCookieHeader } from "../lib/auth";
import { jsonError, validateJson } from "../lib/http";
import { actingUserId, clientIp, normalizeUsername, rateLimit } from "../lib/rate-limit";
import { authMiddleware, requireCoach, type AppBindings } from "../lib/rbac";
import {
  acceptInviteInput, changePasswordInput, createInviteInput, credentialsInput, deleteAccountInput, transferOwnershipInput, type CredentialsInput,
} from "../lib/validation";
import {
  INVITE_TTL_HOURS,
  acceptInvite,
  authenticate,
  bootstrapOwner,
  changePassword,
  createInvite,
  createSession,
  deleteAccount,
  deleteAllSessions,
  deleteSessionByToken,
  listInvites,
  publicUser,
  revokeInvite,
  transferOwnership,
  userCount,
} from "../services/auth";
import { attemptBlobCleanup } from "../services/cleanup";

const auth = new Hono<AppBindings>();

/** Creates a session and sets the cookie; false when the user cannot sign in (deactivated/deleted). */
async function startSession(c: Context<AppBindings>, userId: string, verifiedHash?: string): Promise<boolean> {
  const token = await createSession(getDb(c.env.DB), userId, verifiedHash);
  if (!token) return false;
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return true;
}

function clearSession(c: Context<AppBindings>): void {
  c.header("Set-Cookie", clearSessionCookieHeader(isSecureRequest(c.req.raw)));
}

/** Runs `task` after the response when the runtime offers `waitUntil`; otherwise awaits it. */
async function inBackground(c: Context<AppBindings>, task: Promise<unknown>): Promise<void> {
  const guarded = task.catch(() => { console.error("Background cleanup failed; the scheduled job will retry"); });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    await guarded;
  }
}

const INCORRECT_PASSWORD = "Incorrect password";

// Public: no session required -----------------------------------------------

auth.get("/status", async (c) => {
  const setupRequired = (await userCount(getDb(c.env.DB))) === 0;
  return c.json({ setupRequired });
});

// Rate limits: per-IP checks run before body parsing so invalid bodies count;
// the per-username login check runs after validation and before any hashing.
auth.post("/bootstrap", rateLimit("bootstrap", clientIp), validateJson(credentialsInput), async (c) => {
  const user = await bootstrapOwner(getDb(c.env.DB), c.req.valid("json"));
  if (!user) return jsonError(c, 409, "Setup already completed");
  if (!(await startSession(c, user.id))) return jsonError(c, 401, "Unauthorized");
  return c.json(user, 201);
});

auth.post("/login", rateLimit("login-ip", clientIp), validateJson(credentialsInput),
  rateLimit<{ out: { json: CredentialsInput } }>("login-user", (c) => normalizeUsername(c.req.valid("json").username)), async (c) => {
  const input = c.req.valid("json");
  const user = await authenticate(getDb(c.env.DB), input);
  // Deactivation between authenticate and the guarded session insert gets the
  // same generic answer as a wrong password; account state never leaks here.
  if (!user || !(await startSession(c, user.id, user.passwordHash))) return jsonError(c, 401, "Invalid username or password");
  return c.json(publicUser(user));
});

auth.post("/accept-invite", rateLimit("accept-invite", clientIp), validateJson(acceptInviteInput), async (c) => {
  const result = await acceptInvite(getDb(c.env.DB), c.req.valid("json"));
  switch (result.status) {
    case "unknown": return jsonError(c, 400, "Invalid invite");
    case "expired": return jsonError(c, 410, "Invite has expired or already been used");
    case "not-claimable": return jsonError(c, 410, "Invite has expired, already been used, or is no longer valid");
    case "username-taken": return jsonError(c, 409, "Username is taken");
  }
  if (!(await startSession(c, result.user.id))) return jsonError(c, 401, "Unauthorized");
  return c.json(result.user, 201);
});

// Authenticated --------------------------------------------------------------

auth.post("/logout", authMiddleware, async (c) => {
  const token = getSessionToken(c.req.raw);
  if (token) await deleteSessionByToken(getDb(c.env.DB), token);
  clearSession(c);
  return c.json({ ok: true });
});

auth.post("/logout-all", authMiddleware, async (c) => {
  await deleteAllSessions(getDb(c.env.DB), c.get("user").id);
  clearSession(c);
  return c.json({ ok: true });
});

auth.get("/me", authMiddleware, async (c) => {
  return c.json(publicUser(c.get("user")));
});

// Account lifecycle. Password verification in these three handlers is rate
// limited per acting user (5/min) before any hashing happens.
auth.post("/password", authMiddleware, validateJson(changePasswordInput), rateLimit("password-verify", actingUserId), async (c) => {
  const { currentPassword, newPassword } = c.req.valid("json");
  const result = await changePassword(getDb(c.env.DB), c.get("user").id, c.get("sessionId"), currentPassword, newPassword);
  switch (result) {
    case "wrong-password": return jsonError(c, 400, INCORRECT_PASSWORD);
    case "stale": return jsonError(c, 409, "Password was changed by another request. Sign in again and retry.");
    case "ok": return c.json({ ok: true });
  }
});

auth.delete("/account", authMiddleware, validateJson(deleteAccountInput), rateLimit("password-verify", actingUserId), async (c) => {
  const db = getDb(c.env.DB);
  const result = await deleteAccount(db, c.get("user").id, c.req.valid("json").password);
  switch (result.status) {
    case "wrong-password": return jsonError(c, 400, INCORRECT_PASSWORD);
    case "owner": return jsonError(c, 409, "Transfer ownership before deleting your account");
    case "last-coach": return jsonError(c, 409, "The last coach cannot delete their account");
    case "conflict": return jsonError(c, 409, "Account changed during deletion. Sign in again and retry.");
    case "ok": break;
  }
  clearSession(c);
  // The user row is gone; delete their files now, and let the cron retry any
  // key this attempt misses or fails on.
  if (result.blobKeys.length > 0) await inBackground(c, attemptBlobCleanup(db, c.env.ATTACHMENTS, result.blobKeys));
  return c.json({ ok: true });
});

auth.post("/owner/transfer", authMiddleware, requireCoach, validateJson(transferOwnershipInput), rateLimit("password-verify", actingUserId), async (c) => {
  if (!c.get("user").isOwner) return jsonError(c, 403, "Only the owner can transfer ownership");
  const { coachId, password } = c.req.valid("json");
  const result = await transferOwnership(getDb(c.env.DB), c.get("user").id, coachId, password);
  switch (result) {
    case "not-owner": return jsonError(c, 403, "Only the owner can transfer ownership");
    case "self": return jsonError(c, 400, "Choose a different coach");
    case "wrong-password": return jsonError(c, 400, INCORRECT_PASSWORD);
    case "invalid-target": return jsonError(c, 404, "Coach not found");
    case "conflict": return jsonError(c, 409, "Ownership changed during the transfer. Refresh and retry.");
    case "ok": return c.json({ ok: true, previousOwnerId: c.get("user").id, newOwnerId: coachId });
  }
});

auth.post("/invites", authMiddleware, requireCoach, rateLimit("invite-create", actingUserId), validateJson(createInviteInput), async (c) => {
  const { role } = c.req.valid("json");
  if (role === "coach" && !c.get("user").isOwner) return jsonError(c, 403, "Only the owner can invite coaches");
  const token = await createInvite(getDb(c.env.DB), c.get("user").id, role);
  return c.json({ token, invitePath: `/invite#${token}`, expiresInHours: INVITE_TTL_HOURS }, 201);
});

auth.get("/invites", authMiddleware, requireCoach, async (c) => {
  return c.json(await listInvites(getDb(c.env.DB), c.get("user")));
});

auth.delete("/invites/:id", authMiddleware, requireCoach, async (c) => {
  const revoked = await revokeInvite(getDb(c.env.DB), c.get("user"), c.req.param("id"));
  if (!revoked) return jsonError(c, 404, "Invite not found");
  return c.json({ ok: true });
});

export default auth;
