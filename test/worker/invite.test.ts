// Invite creation, listing, revoking and acceptance (POST /api/auth/accept-invite).
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getDb, type Db } from "../../src/db";
import { sha256Hex } from "../../src/lib/auth";
import { acceptInvite as acceptInviteService } from "../../src/services/auth";
import {
  countRows, credentials, deleteUser, demoteOwner, inviteRowFor, setInviteExpiry, setupTeam, tryAccept, userRow,
} from "./auth-fixtures";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite, login, sessionCookie, DEFAULT_PASSWORD } from "./helpers";

type PublicUser = { id: string; username: string; role: "coach" | "athlete"; isOwner: boolean };
type InviteListRow = { id: string; role: string; createdBy: string | null; expiresAt: number; usedAt: number | null; createdAt: number };

const HOUR = 3600 * 1000;

describe("POST /api/auth/invites", () => {
  it("creates a 24h single-use athlete invite by default and stores only the token hash", async () => {
    const owner = await bootstrapCoach("owner");
    const before = Date.now();
    const { status, body } = await apiJson<{ token: string; invitePath: string; expiresInHours: number }>("/api/auth/invites", { json: {}, cookie: owner.cookie });
    expect(status).toBe(201);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.invitePath).toBe(`/invite/${body.token}`);
    expect(body.expiresInHours).toBe(24);

    const row = await inviteRowFor(body.token);
    expect(row).toMatchObject({ role: "athlete", created_by: owner.user.id, used_at: null });
    expect(row!.token_hash).toBe(await sha256Hex(body.token));
    expect(row!.expires_at - row!.created_at).toBe(24 * HOUR);
    expect(row!.created_at).toBeGreaterThanOrEqual(before - 1000);
    expect(await countRows("invites", "token_hash = ?", body.token)).toBe(0); // raw token never stored
  });

  it("lets only the owner create coach invites; any coach creates athlete invites; athletes get 403", async () => {
    const team = await setupTeam();
    expect((await api("/api/auth/invites", { json: { role: "coach" }, cookie: team.owner.cookie })).status).toBe(201);
    const denied = await apiJson<{ error: string }>("/api/auth/invites", { json: { role: "coach" }, cookie: team.coach.cookie });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: expect.any(String) });
    expect((await api("/api/auth/invites", { json: { role: "athlete" }, cookie: team.coach.cookie })).status).toBe(201);
    expect((await api("/api/auth/invites", { json: {}, cookie: team.coach.cookie })).status).toBe(201);
    for (const json of [{}, { role: "athlete" }, { role: "coach" }]) {
      expect((await api("/api/auth/invites", { json, cookie: team.athleteA.cookie })).status).toBe(403);
    }
    expect((await api("/api/auth/invites", { json: {} })).status).toBe(401);
    // The non-owner coach's refused request created nothing.
    expect(await countRows("invites", "role = 'coach'")).toBe(1 + 1); // setupTeam's coach invite + the owner's
  });

  it("rejects an unknown role with 400", async () => {
    const owner = await bootstrapCoach("owner");
    expect((await api("/api/auth/invites", { json: { role: "owner" }, cookie: owner.cookie })).status).toBe(400);
    expect((await api("/api/auth/invites", { json: { role: "" }, cookie: owner.cookie })).status).toBe(400);
    expect(await countRows("invites")).toBe(0);
  });
});

describe("GET/DELETE /api/auth/invites", () => {
  it("owner lists all invites, other coaches only their own, without tokens", async () => {
    const team = await setupTeam();
    // setupTeam already created invites (owner: coach2 + athleteA; coach2: athleteB); count them rather than assume.
    const ownerInvitesBefore = await countRows("invites", "created_by = ?", team.owner.user.id);
    const coachInvitesBefore = await countRows("invites", "created_by = ?", team.coach.user.id);
    const ownerToken = await createInvite(team.owner);
    const coachToken = await createInvite(team.coach);

    const ownerList = await apiJson<InviteListRow[]>("/api/auth/invites", { cookie: team.owner.cookie });
    expect(ownerList.status).toBe(200);
    expect(ownerList.body).toHaveLength(ownerInvitesBefore + coachInvitesBefore + 2);
    expect(ownerList.body.map((row) => row.createdBy)).toEqual(expect.arrayContaining([team.owner.user.id, team.coach.user.id]));

    const coachList = await apiJson<InviteListRow[]>("/api/auth/invites", { cookie: team.coach.cookie });
    expect(coachList.status).toBe(200);
    expect(coachList.body).toHaveLength(coachInvitesBefore + 1);
    expect(coachList.body.every((row) => row.createdBy === team.coach.user.id)).toBe(true);
    expect(coachList.body.map((row) => row.id)).toContain((await inviteRowFor(coachToken))!.id);
    expect(coachList.body.map((row) => row.id)).not.toContain((await inviteRowFor(ownerToken))!.id);

    for (const row of [...ownerList.body, ...coachList.body]) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "createdBy", "expiresAt", "id", "role", "usedAt"]);
      expect(JSON.stringify(row)).not.toContain(ownerToken);
      expect(JSON.stringify(row)).not.toContain(coachToken);
      expect(JSON.stringify(row)).not.toContain(await sha256Hex(ownerToken));
      expect(typeof row.expiresAt).toBe("number");
    }
    const ownerInviteId = (await inviteRowFor(ownerToken))!.id;
    const listed = ownerList.body.find((row) => row.id === ownerInviteId)!;
    expect(listed).toMatchObject({ role: "athlete", createdBy: team.owner.user.id, usedAt: null });
    expect(listed.expiresAt - listed.createdAt).toBe(24 * HOUR);

    // Athletes see nothing.
    expect((await api("/api/auth/invites", { cookie: team.athleteA.cookie })).status).toBe(403);
    expect((await api("/api/auth/invites")).status).toBe(401);
  });

  it("listing shows usedAt after acceptance and the role of coach invites", async () => {
    const owner = await bootstrapCoach("owner");
    const coachToken = await createInvite(owner, { role: "coach" });
    const athleteToken = await createInvite(owner);
    await acceptInvite(athleteToken, "athlete");
    const list = (await apiJson<InviteListRow[]>("/api/auth/invites", { cookie: owner.cookie })).body;
    const coachInviteId = (await inviteRowFor(coachToken))!.id;
    const athleteInviteId = (await inviteRowFor(athleteToken))!.id;
    const coachRow = list.find((row) => row.id === coachInviteId)!;
    const athleteRow = list.find((row) => row.id === athleteInviteId)!;
    expect(coachRow).toMatchObject({ role: "coach", usedAt: null });
    expect(athleteRow.role).toBe("athlete");
    expect(typeof athleteRow.usedAt).toBe("number");
    expect(Math.abs(athleteRow.usedAt! - Date.now())).toBeLessThan(10_000);
  });

  it("owner can revoke any invite; a coach can revoke only their own; revoked tokens stop working", async () => {
    const team = await setupTeam();
    const ownerToken = await createInvite(team.owner);
    const coachToken = await createInvite(team.coach);
    const coachToken2 = await createInvite(team.coach);
    const ownerInviteId = (await inviteRowFor(ownerToken))!.id;
    const coachInviteId = (await inviteRowFor(coachToken))!.id;
    const coachInviteId2 = (await inviteRowFor(coachToken2))!.id;

    // Coach cannot revoke the owner's invite (404, and it still exists).
    expect((await api(`/api/auth/invites/${ownerInviteId}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(404);
    expect(await inviteRowFor(ownerToken)).not.toBeNull();
    // Athlete cannot revoke anything.
    expect((await api(`/api/auth/invites/${coachInviteId}`, { method: "DELETE", cookie: team.athleteA.cookie })).status).toBe(403);
    expect((await api(`/api/auth/invites/${coachInviteId}`, { method: "DELETE" })).status).toBe(401);
    expect(await inviteRowFor(coachToken)).not.toBeNull();

    // Coach revokes their own.
    const own = await apiJson<{ ok: boolean }>(`/api/auth/invites/${coachInviteId}`, { method: "DELETE", cookie: team.coach.cookie });
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ ok: true });
    expect(await inviteRowFor(coachToken)).toBeNull();
    // Revoking again is 404.
    expect((await api(`/api/auth/invites/${coachInviteId}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(404);
    expect((await api(`/api/auth/invites/does-not-exist`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(404);

    // Owner revokes the other coach's invite.
    expect((await api(`/api/auth/invites/${coachInviteId2}`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(200);
    expect(await inviteRowFor(coachToken2)).toBeNull();

    // A revoked token can no longer be accepted (unknown → 400) and creates no user.
    const users = await countRows("users");
    expect((await tryAccept(coachToken, "late-athlete")).status).toBe(400);
    expect(await countRows("users")).toBe(users);
  });
});

describe("POST /api/auth/accept-invite", () => {
  it("creates the user with the invite's role and invited_by, consumes the invite and logs in", async () => {
    const owner = await bootstrapCoach("owner");
    const athleteToken = await createInvite(owner);
    const coachToken = await createInvite(owner, { role: "coach" });

    const athleteResponse = await tryAccept(athleteToken, "new-athlete");
    expect(athleteResponse.status).toBe(201);
    const athlete = (await athleteResponse.json()) as PublicUser;
    expect(athlete).toEqual({ id: expect.any(String), username: "new-athlete", role: "athlete", isOwner: false });
    const athleteCookie = sessionCookie(athleteResponse);
    expect((await apiJson("/api/auth/me", { cookie: athleteCookie })).body).toEqual(athlete);
    expect(await userRow(athlete.id)).toMatchObject({ role: "athlete", is_owner: 0, invited_by: owner.user.id });
    expect((await inviteRowFor(athleteToken))!.used_at).toEqual(expect.any(Number));

    const coachResponse = await tryAccept(coachToken, "new-coach");
    expect(coachResponse.status).toBe(201);
    const coach = (await coachResponse.json()) as PublicUser;
    expect(coach).toEqual({ id: expect.any(String), username: "new-coach", role: "coach", isOwner: false });
    expect(await userRow(coach.id)).toMatchObject({ role: "coach", is_owner: 0, invited_by: owner.user.id });
    expect((await apiJson("/api/auth/me", { cookie: sessionCookie(coachResponse) })).body).toEqual(coach);

    // Both can log in with the password they chose; the owner is still unique.
    expect((await login("new-athlete")).user).toEqual(athlete);
    expect((await login("new-coach")).user).toEqual(coach);
    expect(await countRows("users", "is_owner = 1")).toBe(1);
    // The new coach is not the owner, so it cannot invite coaches.
    expect((await api("/api/auth/invites", { json: { role: "coach" }, cookie: sessionCookie(coachResponse) })).status).toBe(403);
  });

  it("a coach created from a coach invite records invited_by = the inviting coach, and its athletes record it", async () => {
    const team = await setupTeam();
    expect((await userRow(team.coach.user.id))!.invited_by).toBe(team.owner.user.id);
    expect((await userRow(team.athleteA.user.id))!.invited_by).toBe(team.owner.user.id);
    expect((await userRow(team.athleteB.user.id))!.invited_by).toBe(team.coach.user.id);
  });

  it("rejects an expired invite with 410 without consuming it or creating a user", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    await setInviteExpiry(token, Date.now() - 1);
    const { status, body } = await apiJson<{ error: string }>("/api/auth/accept-invite", { json: { token, ...credentials("late") } });
    expect(status).toBe(410);
    expect(body).toEqual({ error: expect.any(String) });
    expect((await inviteRowFor(token))!.used_at).toBeNull();
    expect(await countRows("users")).toBe(1);
    expect(await countRows("sessions")).toBe(1);
  });

  it("an invite exactly at its expiry instant is expired", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    await setInviteExpiry(token, Date.now());
    expect((await tryAccept(token, "on-the-dot")).status).toBe(410);
    expect(await countRows("users")).toBe(1);
  });

  it("rejects a reused invite with 410", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    await acceptInvite(token, "first");
    const usedAt = (await inviteRowFor(token))!.used_at;
    const again = await apiJson<{ error: string }>("/api/auth/accept-invite", { json: { token, ...credentials("second") } });
    expect(again.status).toBe(410);
    expect(again.response.headers.get("set-cookie")).toBeNull();
    expect(await countRows("users")).toBe(2);
    expect((await inviteRowFor(token))!.used_at).toBe(usedAt); // untouched
    // Reuse with the *same* username also 410 (not 409): the invite is gone.
    expect((await tryAccept(token, "first")).status).toBe(410);
  });

  it("concurrent accepts of the same token give one 201 and one 410, creating one user", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    const responses = await Promise.all([tryAccept(token, "runner-a"), tryAccept(token, "runner-b")]);
    const statuses = responses.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect([...statuses].sort()).toEqual([201, 410]);
    const winner = (await responses[statuses.indexOf(201)]!.json()) as PublicUser;
    expect(await countRows("users")).toBe(2);
    expect(await countRows("users", "role = 'athlete'")).toBe(1);
    expect((await userRow(winner.id))!.username).toBe(winner.username);
    expect(await countRows("sessions")).toBe(2);
    expect((await inviteRowFor(token))!.used_at).toEqual(expect.any(Number));
  });

  it("concurrent accepts of the same token with the same username still create exactly one user", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    const responses = await Promise.all([tryAccept(token, "twin"), tryAccept(token, "twin")]);
    const statuses = responses.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect([...statuses].sort()).toEqual([201, 410]);
    expect(await countRows("users", "username = 'twin'")).toBe(1);
  });

  it("a taken username returns 409 and does NOT consume the invite", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    const clash = await apiJson<{ error: string }>("/api/auth/accept-invite", { json: { token, ...credentials("owner") } });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: expect.any(String) });
    expect(clash.response.headers.get("set-cookie")).toBeNull();
    expect((await inviteRowFor(token))!.used_at).toBeNull();
    expect(await countRows("users")).toBe(1);
    expect(await countRows("sessions")).toBe(1);

    // Case-insensitive collisions count as taken too.
    expect((await tryAccept(token, "OWNER")).status).toBe(409);
    expect((await inviteRowFor(token))!.used_at).toBeNull();

    // The same invite is then accepted with a free username.
    const accepted = await acceptInvite(token, "free-name");
    expect(accepted.user.role).toBe("athlete");
    expect((await inviteRowFor(token))!.used_at).toEqual(expect.any(Number));
    // And a username taken by an *athlete* is refused on another invite.
    const token2 = await createInvite(owner);
    expect((await tryAccept(token2, "free-name")).status).toBe(409);
    expect((await inviteRowFor(token2))!.used_at).toBeNull();
  });

  it("two invites accepted concurrently with the same username: one 201, one 409, the loser's invite stays open", async () => {
    const owner = await bootstrapCoach("owner");
    const tokenA = await createInvite(owner);
    const tokenB = await createInvite(owner);
    const responses = await Promise.all([tryAccept(tokenA, "same-name"), tryAccept(tokenB, "same-name")]);
    const statuses = responses.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect([...statuses].sort()).toEqual([201, 409]);
    expect(await countRows("users", "username = 'same-name'")).toBe(1);
    const rows = [await inviteRowFor(tokenA), await inviteRowFor(tokenB)];
    expect(rows.filter((row) => row!.used_at !== null)).toHaveLength(1);
    expect(rows.filter((row) => row!.used_at === null)).toHaveLength(1);
    // The unconsumed invite still works for a different name.
    const loserToken = statuses[0] === 409 ? tokenA : tokenB;
    expect((await tryAccept(loserToken, "other-name")).status).toBe(201);
  });

  it("an invite that expires between the pre-read and the batch is refused and creates no user", async () => {
    // Set expiry before reading, then delay submission across the deadline.
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    const expiry = Date.now() + 1000;
    await setInviteExpiry(token, expiry);
    const real = getDb(env.DB);
    const realBatch = real.batch.bind(real);
    const db = Object.assign(Object.create(real) as Db, {
      async batch(statements: never) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry - Date.now()) + 50));
        expect(Date.now()).toBeGreaterThan(expiry);
        return realBatch(statements);
      },
    });
    const result = await acceptInviteService(db, { token, ...credentials("too-late") });
    expect(result.status).not.toBe("ok");
    expect(await countRows("users")).toBe(1);
    expect((await inviteRowFor(token))!.used_at).toBeNull();

    // Same through the API: the invite expires a few ms after creation, so it
    // is either caught by the pre-read or by the batch; both must be 410.
    const token2 = await createInvite(owner);
    await setInviteExpiry(token2, Date.now() + 5);
    const { status } = await apiJson("/api/auth/accept-invite", { json: { token: token2, ...credentials("too-late-2") } });
    expect(status).toBe(410);
    expect(await countRows("users")).toBe(1);
    expect((await inviteRowFor(token2))!.used_at).toBeNull();
  });

  it("an athlete invite is still accepted after its creating coach was deleted", async () => {
    const team = await setupTeam();
    const token = await createInvite(team.coach);
    await deleteUser(team.coach.user.id);
    expect((await inviteRowFor(token))!.created_by).toBeNull(); // ON DELETE SET NULL
    const response = await tryAccept(token, "orphan-athlete");
    expect(response.status).toBe(201);
    const user = (await response.json()) as PublicUser;
    expect(user.role).toBe("athlete");
    expect((await userRow(user.id))!.invited_by).toBeNull();
    expect((await inviteRowFor(token))!.used_at).toEqual(expect.any(Number));
    // The athlete invited earlier by the deleted coach keeps working and the team still sees them.
    expect((await api("/api/auth/me", { cookie: team.athleteB.cookie })).status).toBe(200);
    expect((await userRow(team.athleteB.user.id))!.invited_by).toBeNull();
  });

  it("an athlete invite created by the owner is still accepted after the owner was deleted", async () => {
    const team = await setupTeam();
    const token = await createInvite(team.owner);
    await deleteUser(team.owner.user.id);
    expect((await tryAccept(token, "post-owner-athlete")).status).toBe(201);
  });

  it("a coach invite is refused with 410 once its creator is no longer the owner (demoted)", async () => {
    const team = await setupTeam();
    const token = await createInvite(team.owner, { role: "coach" });
    await demoteOwner(team.owner.user.id);
    const { status, body } = await apiJson<{ error: string }>("/api/auth/accept-invite", { json: { token, ...credentials("would-be-coach") } });
    expect(status).toBe(410);
    expect(body).toEqual({ error: expect.any(String) });
    expect(await countRows("users", "username = 'would-be-coach'")).toBe(0);
    expect((await inviteRowFor(token))!.used_at).toBeNull();
  });

  it("a coach invite is refused with 410 once its creator was deleted", async () => {
    const team = await setupTeam();
    const token = await createInvite(team.owner, { role: "coach" });
    await deleteUser(team.owner.user.id);
    expect((await inviteRowFor(token))!.created_by).toBeNull();
    expect((await tryAccept(token, "would-be-coach")).status).toBe(410);
    expect(await countRows("users", "role = 'coach'")).toBe(1);
    expect((await inviteRowFor(token))!.used_at).toBeNull();
  });

  it("a coach invite whose creator was never the owner cannot be accepted even if it exists in the DB", async () => {
    // Defence in depth: a coach-role invite row inserted for a non-owner coach
    // (e.g. by a future bug or a manual DB edit) must not mint a coach.
    const team = await setupTeam();
    const token = await createInvite(team.coach); // athlete invite
    await env.DB.prepare("UPDATE invites SET role = 'coach' WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    expect((await tryAccept(token, "smuggled-coach")).status).toBe(410);
    expect(await countRows("users", "username = 'smuggled-coach'")).toBe(0);
  });

  it("rejects unknown tokens and invalid bodies with 400", async () => {
    const owner = await bootstrapCoach("owner");
    const token = await createInvite(owner);
    expect((await tryAccept("0".repeat(64), "someone")).status).toBe(400);
    expect((await api("/api/auth/accept-invite", { json: { token, username: "x", password: DEFAULT_PASSWORD } })).status).toBe(400);
    expect((await api("/api/auth/accept-invite", { json: { token, username: "someone", password: "short" } })).status).toBe(400);
    expect((await api("/api/auth/accept-invite", { json: { username: "someone", password: DEFAULT_PASSWORD } })).status).toBe(400);
    expect((await api("/api/auth/accept-invite", { json: { token: "", ...credentials("someone") } })).status).toBe(400);
    expect((await inviteRowFor(token))!.used_at).toBeNull();
    expect(await countRows("users")).toBe(1);
  });

  it("accepting an invite never changes the owner", async () => {
    const owner = await bootstrapCoach("owner");
    await acceptInvite(await createInvite(owner, { role: "coach" }), "coach2");
    await acceptInvite(await createInvite(owner), "athlete");
    expect(await countRows("users", "is_owner = 1")).toBe(1);
    expect((await userRow(owner.user.id))!.is_owner).toBe(1);
  });
});

// Force the used_at marker to collide; changes() must still associate each
// insert with its own claim, independent of timing or username uniqueness.
it("only one claim succeeds when concurrent batches share a millisecond", async () => {
  const owner = await bootstrapCoach("owner");
  const token = await createInvite(owner);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date());
    const results = await Promise.all(["one", "two"].map(username =>
      acceptInviteService(getDb(env.DB), { token, ...credentials(username) })));
    expect(results.map(r => r.status).sort()).toEqual(["not-claimable", "ok"]);
    expect(await countRows("users")).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
