// Bootstrap, login, logout, sessions and /api/auth/me. Invites live in
// invite.test.ts; the coach/athlete matrix in rbac.test.ts.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/auth";
import { countRows, credentials, setupTeam, userRow } from "./auth-fixtures";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite, login, sessionCookie, DEFAULT_PASSWORD } from "./helpers";

type PublicUser = { id: string; username: string; role: "coach" | "athlete"; isOwner: boolean };

describe("POST /api/auth/bootstrap", () => {
  it("creates the owner coach, sets a session cookie and flips setupRequired", async () => {
    expect((await apiJson<{ setupRequired: boolean }>("/api/auth/status")).body).toEqual({ setupRequired: true });

    const response = await api("/api/auth/bootstrap", { json: credentials("first-coach") });
    expect(response.status).toBe(201);
    const user = (await response.json()) as PublicUser;
    expect(user).toEqual({ id: expect.any(String), username: "first-coach", role: "coach", isOwner: true });
    expect(Object.keys(user).sort()).toEqual(["id", "isOwner", "role", "username"]);

    const cookie = sessionCookie(response);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect(response.headers.get("set-cookie")).toMatch(/Path=\//);
    expect(response.headers.get("set-cookie")).not.toMatch(/Secure/); // plain http in tests

    const stored = await userRow(user.id);
    expect(stored).toMatchObject({ username: "first-coach", role: "coach", is_owner: 1, invited_by: null });
    expect(stored?.password_hash).toMatch(/^pbkdf2\$100000\$/);
    expect(stored?.password_hash).not.toContain(DEFAULT_PASSWORD);

    expect((await apiJson<{ setupRequired: boolean }>("/api/auth/status")).body).toEqual({ setupRequired: false });
    expect((await apiJson("/api/auth/me", { cookie })).body).toEqual(user);
  });

  it("sets the Secure cookie flag when the request came over https", async () => {
    const response = await SELF.fetch("https://example.com/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify(credentials("secure-coach")),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("returns 409 for a second bootstrap and leaves the first account untouched", async () => {
    const owner = await bootstrapCoach("owner");
    const { status, body } = await apiJson<{ error: string }>("/api/auth/bootstrap", { json: credentials("intruder") });
    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.any(String) });
    expect(await countRows("users")).toBe(1);
    expect(await countRows("users", "username = ?", "intruder")).toBe(0);
    // The loser must not get a session cookie either.
    const loser = await api("/api/auth/bootstrap", { json: credentials("intruder2") });
    expect(loser.headers.get("set-cookie")).toBeNull();
    // Even reusing the owner's own username is refused (not an upsert).
    expect((await api("/api/auth/bootstrap", { json: credentials("owner") })).status).toBe(409);
    expect((await apiJson("/api/auth/me", { cookie: owner.cookie })).body).toEqual(owner.user);
  });

  it("gives exactly one 201 and one 409 to concurrent bootstraps, with no orphan user and no 500", async () => {
    const responses = await Promise.all([
      api("/api/auth/bootstrap", { json: credentials("racer-a") }),
      api("/api/auth/bootstrap", { json: credentials("racer-b") }),
    ]);
    const statuses = responses.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect([...statuses].sort()).toEqual([201, 409]);

    const winner = responses[statuses.indexOf(201)]!;
    const winnerUser = (await winner.json()) as PublicUser;
    expect(await countRows("users")).toBe(1);
    expect(await countRows("users", "is_owner = 1")).toBe(1);
    expect((await userRow(winnerUser.id))?.username).toBe(winnerUser.username);
    // Exactly one session was created (for the winner) and it works.
    expect(await countRows("sessions")).toBe(1);
    expect((await apiJson("/api/auth/me", { cookie: sessionCookie(winner) })).body).toEqual(winnerUser);
    // The loser can log in with nothing: its credentials were never stored.
    const loserName = winnerUser.username === "racer-a" ? "racer-b" : "racer-a";
    expect((await api("/api/auth/login", { json: credentials(loserName) })).status).toBe(401);
  });

  it("rejects invalid credentials with 400 and creates nothing", async () => {
    const cases: Array<Record<string, unknown>> = [
      { username: "ab", password: DEFAULT_PASSWORD }, // too short
      { username: "bad name", password: DEFAULT_PASSWORD }, // space
      { username: "coach", password: "short" }, // password < 8
      { username: "coach" }, // missing password
      {},
    ];
    for (const json of cases) {
      const { status, body } = await apiJson<{ error: string }>("/api/auth/bootstrap", { json });
      expect(status, JSON.stringify(json)).toBe(400);
      expect(body).toEqual({ error: expect.any(String) });
    }
    expect(await countRows("users")).toBe(0);
    expect((await apiJson<{ setupRequired: boolean }>("/api/auth/status")).body.setupRequired).toBe(true);
  });
});

describe("POST /api/auth/login and /api/auth/logout", () => {
  it("logs in with the right password and rejects wrong password or unknown user with 401", async () => {
    const owner = await bootstrapCoach("owner");
    const good = await api("/api/auth/login", { json: credentials("owner") });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual(owner.user);
    expect(sessionCookie(good)).not.toBe(owner.cookie); // a fresh session, not the bootstrap one

    const wrong = await apiJson<{ error: string }>("/api/auth/login", { json: { username: "owner", password: "not-the-password" } });
    expect(wrong.status).toBe(401);
    expect(wrong.response.headers.get("set-cookie")).toBeNull();
    const unknown = await apiJson<{ error: string }>("/api/auth/login", { json: credentials("nobody") });
    expect(unknown.status).toBe(401);
    // Same error text for both, so usernames can't be enumerated.
    expect(unknown.body).toEqual(wrong.body);
    expect(await countRows("sessions")).toBe(2);
  });

  it("treats usernames case-insensitively at login", async () => {
    await bootstrapCoach("MixedCase");
    const session = await login("mixedcase");
    expect(session.user.username).toBe("MixedCase");
    expect((await api("/api/auth/login", { json: credentials("MIXEDCASE") })).status).toBe(200);
  });

  it("validates the login body", async () => {
    await bootstrapCoach("owner");
    expect((await api("/api/auth/login", { json: { username: "owner" } })).status).toBe(400);
    expect((await api("/api/auth/login", { json: { username: "x", password: DEFAULT_PASSWORD } })).status).toBe(400);
    const malformed = await api("/api/auth/login", { body: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: expect.any(String) });
  });

  it("logout deletes only the current session and clears the cookie", async () => {
    const owner = await bootstrapCoach("owner");
    const other = await login("owner");
    expect(await countRows("sessions")).toBe(2);

    const response = await api("/api/auth/logout", { method: "POST", cookie: owner.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toMatch(/dga_session=;/);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    expect(await countRows("sessions")).toBe(1);
    expect((await api("/api/auth/me", { cookie: owner.cookie })).status).toBe(401);
    expect((await api("/api/auth/logout", { method: "POST", cookie: owner.cookie })).status).toBe(401);
    // The other session of the same user is still valid.
    expect((await apiJson("/api/auth/me", { cookie: other.cookie })).body).toEqual(owner.user);
  });

  it("requires a session for logout and me", async () => {
    await bootstrapCoach("owner");
    expect((await api("/api/auth/logout", { method: "POST" })).status).toBe(401);
    expect((await api("/api/auth/me")).status).toBe(401);
    expect((await api("/api/auth/me", { cookie: "dga_session=not-a-real-token" })).status).toBe(401);
    expect((await api("/api/auth/me", { cookie: "dga_session=" })).status).toBe(401);
  });

  it("rejects an expired session and a session whose user was deleted", async () => {
    const owner = await bootstrapCoach("owner");
    const token = decodeURIComponent(owner.cookie.slice("dga_session=".length));
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1, await sha256Hex(token)).run();
    expect((await api("/api/auth/me", { cookie: owner.cookie })).status).toBe(401);

    const athleteSession = await acceptInvite(await createInvite(await login("owner")), "athlete");
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(athleteSession.user.id).run();
    expect(await countRows("sessions", "user_id = ?", athleteSession.user.id)).toBe(0); // cascade
    expect((await api("/api/auth/me", { cookie: athleteSession.cookie })).status).toBe(401);
  });

  it("stores session tokens hashed, never raw", async () => {
    const owner = await bootstrapCoach("owner");
    const token = decodeURIComponent(owner.cookie.slice("dga_session=".length));
    const row = await env.DB.prepare("SELECT token_hash, expires_at, created_at FROM sessions").first<{ token_hash: string; expires_at: number; created_at: number }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.token_hash).not.toBe(token);
    // 30-day TTL.
    expect(row!.expires_at - row!.created_at).toBe(30 * 86400 * 1000);
  });
});

describe("GET /api/auth/me", () => {
  it("returns isOwner true only for the bootstrap coach and never leaks hashes or invitedBy", async () => {
    const team = await setupTeam();
    const me = async (cookie: string) => (await apiJson<Record<string, unknown>>("/api/auth/me", { cookie })).body;

    const owner = await me(team.owner.cookie);
    expect(owner).toEqual({ id: team.owner.user.id, username: "owner", role: "coach", isOwner: true });
    expect(await me(team.coach.cookie)).toEqual({ id: team.coach.user.id, username: "coach2", role: "coach", isOwner: false });
    expect(await me(team.athleteA.cookie)).toEqual({ id: team.athleteA.user.id, username: "athleteA", role: "athlete", isOwner: false });
    expect(await me(team.athleteB.cookie)).toEqual({ id: team.athleteB.user.id, username: "athleteB", role: "athlete", isOwner: false });

    for (const body of [owner, await me(team.coach.cookie), await me(team.athleteA.cookie)]) {
      expect(body).not.toHaveProperty("passwordHash");
      expect(body).not.toHaveProperty("password_hash");
      expect(body).not.toHaveProperty("invitedBy");
      expect(body).not.toHaveProperty("coachId");
    }
  });

  it("login responses carry isOwner too", async () => {
    const team = await setupTeam();
    expect((await login("owner")).user).toEqual({ ...team.owner.user, isOwner: true });
    expect((await login("coach2")).user).toEqual({ ...team.coach.user, isOwner: false });
    expect((await login("athleteA")).user.isOwner).toBe(false);
  });
});
