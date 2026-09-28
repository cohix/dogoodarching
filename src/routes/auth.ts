// Auth endpoints: bootstrap, login, logout, invites. Handlers only; the
// account/session/invite logic lives in services/auth.ts.

import { Hono } from "hono";
import { getDb } from "../db";
import { clearSessionCookieHeader, getSessionToken, isSecureRequest, sessionCookieHeader } from "../lib/auth";
import { jsonError, validateJson } from "../lib/http";
import { clientIp, rateLimit } from "../lib/rate-limit";
import { authMiddleware, requireCoach, type AppBindings } from "../lib/rbac";
import { acceptInviteInput, createInviteInput, credentialsInput } from "../lib/validation";
import {
  INVITE_TTL_HOURS,
  acceptInvite,
  authenticate,
  bootstrapOwner,
  createInvite,
  createSession,
  deleteSessionByToken,
  listInvites,
  publicUser,
  revokeInvite,
  userCount,
} from "../services/auth";

const auth = new Hono<AppBindings>();

// Public: no session required -----------------------------------------------

auth.get("/status", async (c) => {
  const setupRequired = (await userCount(getDb(c.env.DB))) === 0;
  return c.json({ setupRequired });
});

auth.post("/bootstrap", rateLimit((c) => `bootstrap:${clientIp(c)}`, 10, 3600 * 1000), validateJson(credentialsInput), async (c) => {
  const user = await bootstrapOwner(getDb(c.env.DB), c.req.valid("json"));
  if (!user) return jsonError(c, 409, "Setup already completed");
  const token = await createSession(getDb(c.env.DB), user.id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json(user, 201);
});

auth.post("/login", rateLimit((c) => `login:${clientIp(c)}`, 20, 10 * 60 * 1000), validateJson(credentialsInput), async (c) => {
  const user = await authenticate(getDb(c.env.DB), c.req.valid("json"));
  if (!user) return jsonError(c, 401, "Invalid username or password");
  const token = await createSession(getDb(c.env.DB), user.id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json(publicUser(user));
});

auth.post("/accept-invite", rateLimit((c) => `accept-invite:${clientIp(c)}`, 20, 10 * 60 * 1000), validateJson(acceptInviteInput), async (c) => {
  const result = await acceptInvite(getDb(c.env.DB), c.req.valid("json"));
  switch (result.status) {
    case "unknown": return jsonError(c, 400, "Invalid invite");
    case "expired": return jsonError(c, 410, "Invite has expired or already been used");
    case "not-claimable": return jsonError(c, 410, "Invite has expired, already been used, or is no longer valid");
    case "username-taken": return jsonError(c, 409, "Username is taken");
  }
  const token = await createSession(getDb(c.env.DB), result.user.id);
  c.header("Set-Cookie", sessionCookieHeader(token, isSecureRequest(c.req.raw)));
  return c.json(result.user, 201);
});

// Authenticated --------------------------------------------------------------

auth.post("/logout", authMiddleware, async (c) => {
  const token = getSessionToken(c.req.raw);
  if (token) await deleteSessionByToken(getDb(c.env.DB), token);
  c.header("Set-Cookie", clearSessionCookieHeader(isSecureRequest(c.req.raw)));
  return c.json({ ok: true });
});

auth.get("/me", authMiddleware, async (c) => {
  return c.json(publicUser(c.get("user")));
});

auth.post("/invites", authMiddleware, requireCoach, rateLimit((c) => `invite-create:${c.get("user").id}`, 20, 3600 * 1000), validateJson(createInviteInput), async (c) => {
  const { role } = c.req.valid("json");
  if (role === "coach" && !c.get("user").isOwner) return jsonError(c, 403, "Only the owner can invite coaches");
  const token = await createInvite(getDb(c.env.DB), c.get("user").id, role);
  return c.json({ token, invitePath: `/invite/${token}`, expiresInHours: INVITE_TTL_HOURS }, 201);
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
