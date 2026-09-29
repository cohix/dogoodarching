// Account and session lifecycle (0002 §7): password change, logout-all,
// account deletion, athlete deactivation/reactivation and ownership transfer.
// Every write is proven against real D1/R2 through the Worker; the ownership
// tests end by checking that exactly one owner row exists.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/db";
import { sha256Hex } from "../../src/lib/auth";
import { changePassword, createSession, deleteAccount, transferOwnership } from "../../src/services/auth";
import { runScheduledCleanup } from "../../src/services/cleanup";
import {
  countRows, credentials, demoteOwner, setupTeam, tryAccept, uploadFileForAthlete, uploadOwnFile, userRow,
} from "./auth-fixtures";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite, DEFAULT_PASSWORD, login, resetStorage, type Session } from "./helpers";

type Me = { id: string; username: string; role: string; isOwner: boolean };
type AthleteStatus = { id: string; username: string; createdAt: string; deactivatedAt: string | null };
type Roster = { athletes: AthleteStatus[] };

async function ownerCount(): Promise<number> {
  return countRows("users", "is_owner = 1");
}

async function me(session: Session) {
  return apiJson<Me>("/api/auth/me", { cookie: session.cookie });
}

async function roster(coach: Session, query = ""): Promise<Roster> {
  const { status, body } = await apiJson<Roster>(`/api/coach/athletes${query}`, { cookie: coach.cookie });
  if (status !== 200) throw new Error(`roster failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

/** The session row id behind a test session's cookie. */
async function sessionIdOf(session: Session): Promise<string> {
  const token = decodeURIComponent(session.cookie.slice("dga_session=".length));
  const row = await env.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ id: string }>();
  if (!row) throw new Error("session row not found");
  return row.id;
}

/** A pre-0008 coach-owned plan file: the attachment row plus its R2 object. */
async function seedLegacyCoachFile(coachId: string): Promise<void> {
  const key = `plans/${coachId}/legacy-coach-notes`;
  await env.ATTACHMENTS.put(key, new Uint8Array([1, 2, 3]));
  await env.DB.prepare("INSERT INTO planned_session_attachments (user_id, day_key, kind, label, blob_key, mime_type, created_at) VALUES (?, 'mon', 'document', 'Coach notes', ?, 'application/pdf', ?)")
    .bind(coachId, key, Date.now()).run();
}

async function blobKeysFor(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT blob_key FROM planned_session_attachments WHERE user_id = ? AND blob_key != ''").bind(userId).all<{ blob_key: string }>();
  return results.map((row) => row.blob_key);
}

afterEach(() => {
  env.RATE_LIMIT_MODE = "allow";
});

describe("POST /api/auth/password", () => {
  it("changes the password, keeps the current session and revokes every other one", async () => {
    const owner = await bootstrapCoach("owner");
    const other = await login("owner");
    const third = await login("owner");
    expect(await countRows("sessions", "user_id = ?", owner.user.id)).toBe(3);

    const changed = await apiJson("/api/auth/password", {
      json: { currentPassword: DEFAULT_PASSWORD, newPassword: "new-password-123" }, cookie: other.cookie,
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ ok: true });

    // The calling session survives; the others are gone.
    expect((await me(other)).status).toBe(200);
    expect((await me(owner)).status).toBe(401);
    expect((await me(third)).status).toBe(401);
    expect(await countRows("sessions", "user_id = ?", owner.user.id)).toBe(1);

    // Old password rejected, new one accepted.
    expect((await api("/api/auth/login", { json: credentials("owner") })).status).toBe(401);
    const fresh = await login("owner", "new-password-123");
    expect(fresh.user.isOwner).toBe(true);
  });

  it("rejects a wrong current password (400) and changes nothing", async () => {
    const owner = await bootstrapCoach("owner");
    const other = await login("owner");
    const before = await userRow(owner.user.id);
    const wrong = await apiJson<{ error: string }>("/api/auth/password", {
      json: { currentPassword: "not-the-password", newPassword: "new-password-123" }, cookie: owner.cookie,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: "Incorrect password" });
    expect((await userRow(owner.user.id))?.password_hash).toBe(before?.password_hash);
    expect((await me(other)).status).toBe(200); // no session was revoked
  });

  it("validates the body with the shared schemas", async () => {
    const owner = await bootstrapCoach("owner");
    expect((await api("/api/auth/password", { json: { currentPassword: DEFAULT_PASSWORD, newPassword: "short" }, cookie: owner.cookie })).status).toBe(400);
    expect((await api("/api/auth/password", { json: { currentPassword: "", newPassword: "new-password-123" }, cookie: owner.cookie })).status).toBe(400);
    expect((await api("/api/auth/password", { json: {}, cookie: owner.cookie })).status).toBe(400);
    expect((await api("/api/auth/password", { json: { currentPassword: DEFAULT_PASSWORD, newPassword: "new-password-123" } })).status).toBe(401);
  });

  it("two changes that verified the same old hash: one wins, the other is stale (409) and revokes nothing", async () => {
    // SELF.fetch requests run one after another in this harness, so the race
    // is driven through the service: both calls read and verify the same hash
    // before either batch runs, exactly like two overlapping requests.
    const owner = await bootstrapCoach("owner");
    const a = await login("owner");
    const b = await login("owner");
    const db = getDb(env.DB);
    const [sessionA, sessionB] = [await sessionIdOf(a), await sessionIdOf(b)];
    const [ra, rb] = await Promise.all([
      changePassword(db, owner.user.id, sessionA, DEFAULT_PASSWORD, "password-from-a"),
      changePassword(db, owner.user.id, sessionB, DEFAULT_PASSWORD, "password-from-b"),
    ]);
    expect([ra, rb].sort()).toEqual(["ok", "stale"]);
    const winner = ra === "ok" ? { session: a, password: "password-from-a", loser: b } : { session: b, password: "password-from-b", loser: a };
    expect((await me(winner.session)).status).toBe(200);
    expect((await me(winner.loser)).status).toBe(401);
    expect((await me(owner)).status).toBe(401);
    expect(await countRows("sessions", "user_id = ?", owner.user.id)).toBe(1);
    expect((await login("owner", winner.password)).user.id).toBe(owner.user.id);
    // The stale request through the API reports 409 once the hash it verified is gone.
    const stale = await apiJson<{ error: string }>("/api/auth/password", {
      json: { currentPassword: DEFAULT_PASSWORD, newPassword: "password-from-c" }, cookie: winner.session.cookie,
    });
    expect(stale.status).toBe(400); // sequential: the old password is simply wrong now
  });

  it("password verification is rate limited per acting user", async () => {
    const owner = await bootstrapCoach("owner");
    env.RATE_LIMIT_MODE = `deny:password-verify:${owner.user.id}`;
    const limited = await apiJson<{ error: string }>("/api/auth/password", {
      json: { currentPassword: DEFAULT_PASSWORD, newPassword: "new-password-123" }, cookie: owner.cookie,
    });
    expect(limited.status).toBe(429);
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: owner.cookie })).status).toBe(429);
    expect((await api("/api/auth/owner/transfer", { json: { coachId: "x", password: DEFAULT_PASSWORD }, cookie: owner.cookie })).status).toBe(429);
    env.RATE_LIMIT_MODE = "allow";
    expect((await me(owner)).status).toBe(200); // nothing changed
  });
});

describe("POST /api/auth/logout-all", () => {
  it("deletes every session of the caller and clears the cookie", async () => {
    const owner = await bootstrapCoach("owner");
    const other = await login("owner");
    const athlete = await acceptInvite(await createInvite(owner), "athlete");
    const response = await api("/api/auth/logout-all", { method: "POST", cookie: other.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toMatch(/dga_session=;.*Max-Age=0/);
    expect((await me(owner)).status).toBe(401);
    expect((await me(other)).status).toBe(401);
    expect(await countRows("sessions", "user_id = ?", owner.user.id)).toBe(0);
    expect((await me(athlete)).status).toBe(200); // other users untouched
    expect((await api("/api/auth/logout-all", { method: "POST" })).status).toBe(401);
  });
});

describe("DELETE /api/auth/account", () => {
  it("refuses the owner with 409 until ownership is transferred", async () => {
    const team = await setupTeam();
    const refused = await apiJson<{ error: string }>("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.owner.cookie });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "Transfer ownership before deleting your account" });
    expect(await userRow(team.owner.user.id)).not.toBeNull();
    expect((await me(team.owner)).status).toBe(200);
    expect(await countRows("blob_cleanup")).toBe(0);

    expect((await api("/api/auth/owner/transfer", { json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie })).status).toBe(200);
    const deleted = await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.owner.cookie });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("set-cookie")).toMatch(/dga_session=;.*Max-Age=0/);
    expect(await userRow(team.owner.user.id)).toBeNull();
    expect(await ownerCount()).toBe(1);
  });

  it("refuses the last active coach with 409 even when nobody is owner", async () => {
    const team = await setupTeam();
    await demoteOwner(team.owner.user.id); // two plain coaches, no owner
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.coach.cookie })).status).toBe(200);
    const refused = await apiJson<{ error: string }>("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.owner.cookie });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "The last coach cannot delete their account" });
    expect(await userRow(team.owner.user.id)).not.toBeNull();
    expect(await countRows("users", "role = 'coach'")).toBe(1);
  });

  it("rejects a wrong password (400) and leaves the account intact", async () => {
    const team = await setupTeam();
    const wrong = await apiJson<{ error: string }>("/api/auth/account", { method: "DELETE", json: { password: "wrong-password" }, cookie: team.coach.cookie });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: "Incorrect password" });
    expect(await userRow(team.coach.user.id)).not.toBeNull();
    expect((await me(team.coach)).status).toBe(200);
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD } })).status).toBe(401);
    expect((await api("/api/auth/account", { method: "DELETE", json: {}, cookie: team.coach.cookie })).status).toBe(400);
  });

  it("deleting a non-owner coach removes their rows and files, keeps athletes, their files and invites, and nulls references", async () => {
    const team = await setupTeam();
    const coachId = team.coach.user.id;
    // A legacy own plan file (coaches can no longer create personal rows through
    // the API since 0003 §5, so seed it as a pre-0008 row), and a file the coach
    // uploaded onto athleteA's plan.
    await seedLegacyCoachFile(coachId);
    const athleteFileId = await uploadFileForAthlete(team.coach, team.athleteA.user.id, { label: "For athlete" });
    const [coachKey] = await blobKeysFor(coachId);
    const [athleteKey] = await blobKeysFor(team.athleteA.user.id);
    expect(coachKey).toBeTruthy();
    expect(athleteKey).toBeTruthy();
    expect(await env.ATTACHMENTS.head(coachKey!)).not.toBeNull();
    // A pending athlete invite from this coach, a legacy training session of their own,
    // and a team meal they posted (0003 §3).
    const pendingAthleteInvite = await createInvite(team.coach);
    await env.DB.prepare("INSERT INTO training_sessions (user_id, session_date, session_type, arrows, created_at) VALUES (?, '2026-09-21', 'Range', 30, ?)")
      .bind(coachId, Date.now()).run();
    expect((await api("/api/coach/meals", { json: { name: "Coach oats", summary: "s", ingredients: "i", instructions: "m" }, cookie: team.coach.cookie })).status).toBe(200);
    expect((await userRow(team.athleteB.user.id))?.invited_by).toBe(coachId);

    const deleted = await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.coach.cookie });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(deleted.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    // User-scoped rows are gone; the session cookie is dead.
    expect(await userRow(coachId)).toBeNull();
    for (const table of ["sessions", "training_sessions", "planned_session_attachments", "program_state"]) {
      expect(await countRows(table, "user_id = ?", coachId), table).toBe(0);
    }
    expect((await me(team.coach)).status).toBe(401);
    expect((await api("/api/auth/login", { json: credentials("coach2") })).status).toBe(401);

    // Athletes and their plans are untouched; the coach-uploaded file stays.
    expect(await userRow(team.athleteA.user.id)).not.toBeNull();
    expect((await userRow(team.athleteB.user.id))?.invited_by).toBeNull();
    expect(await countRows("planned_session_attachments", "id = ?", athleteFileId)).toBe(1);
    expect(await env.ATTACHMENTS.head(athleteKey!)).not.toBeNull();
    expect((await api(`/api/plan/attachments/${athleteFileId}/file`, { cookie: team.athleteA.cookie })).status).toBe(200);
    expect((await me(team.athleteA)).status).toBe(200);
    expect((await roster(team.owner)).athletes.map((a) => a.username)).toEqual(["athleteA", "athleteB"]);
    // The team meal stays, with a NULL author shown as "Coach".
    expect(await env.DB.prepare("SELECT author_id FROM team_meals").first("author_id")).toBeNull();
    const meals = await apiJson<{ meals: Array<{ name: string; author: string }> }>("/api/coach/meals", { cookie: team.owner.cookie });
    expect(meals.body.meals.map((meal) => [meal.name, meal.author])).toEqual([["Coach oats", "Coach"]]);

    // The unexpired athlete invite is still usable (creator NULL is fine for athletes).
    const invite = await env.DB.prepare("SELECT created_by FROM invites WHERE used_at IS NULL").first<{ created_by: string | null }>();
    expect(invite?.created_by).toBeNull();
    expect((await tryAccept(pendingAthleteInvite, "newAthlete")).status).toBe(201);

    // The coach's own file: queued in the same batch, deleted after commit
    // (promptly via waitUntil, or by the scheduled job), never before.
    await vi.waitFor(async () => {
      expect(await env.ATTACHMENTS.head(coachKey!)).toBeNull();
      expect(await countRows("blob_cleanup")).toBe(0);
    }, { timeout: 5000 });
    // Idempotent: another run has nothing to do and touches nothing else.
    expect((await runScheduledCleanup(env)).blobs).toEqual({ deleted: 0, failed: 0, skippedReferenced: 0 });
    expect(await env.ATTACHMENTS.head(athleteKey!)).not.toBeNull();
    expect(await ownerCount()).toBe(1);
  });

  it("a coach invite whose creator was deleted after transferring ownership is unusable", async () => {
    const team = await setupTeam();
    const coachInvite = await createInvite(team.owner, { role: "coach" });
    expect((await api("/api/auth/owner/transfer", { json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie })).status).toBe(200);
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.owner.cookie })).status).toBe(200);
    expect((await tryAccept(coachInvite, "newCoach")).status).toBe(410);
    expect(await countRows("users", "role = 'coach'")).toBe(1);
    expect(await ownerCount()).toBe(1);
  });

  it("athletes can delete their own account; their files are queued and removed", async () => {
    const team = await setupTeam();
    await uploadOwnFile(team.athleteA);
    const [key] = await blobKeysFor(team.athleteA.user.id);
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.athleteA.cookie })).status).toBe(200);
    expect(await userRow(team.athleteA.user.id)).toBeNull();
    await vi.waitFor(async () => {
      expect(await env.ATTACHMENTS.head(key!)).toBeNull();
    }, { timeout: 5000 });
    expect((await roster(team.owner)).athletes.map((a) => a.username)).toEqual(["athleteB"]);
  });
});

describe("athlete deactivation", () => {
  it("deactivate revokes sessions, blocks login, hides the athlete, keeps data; reactivate restores access", async () => {
    const team = await setupTeam();
    const athleteId = team.athleteA.user.id;
    const secondSession = await login("athleteA");
    expect((await api("/api/sessions", {
      json: { sessionDate: "2026-09-21", sessionType: "Range", customActivity: "", arrows: 42, durationMinutes: 30, focus: "", score: "", notes: "keep me" },
      cookie: team.athleteA.cookie,
    })).status).toBe(200);

    const deactivated = await apiJson<AthleteStatus>(`/api/coach/athletes/${athleteId}/deactivate`, { method: "POST", cookie: team.coach.cookie });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body).toMatchObject({ id: athleteId, username: "athleteA" });
    expect(typeof deactivated.body.deactivatedAt).toBe("string");

    // Open sessions are dead on the next request; login gives the generic 401.
    expect((await me(team.athleteA)).status).toBe(401);
    expect((await me(secondSession)).status).toBe(401);
    expect(await countRows("sessions", "user_id = ?", athleteId)).toBe(0);
    const loginAttempt = await apiJson<{ error: string }>("/api/auth/login", { json: credentials("athleteA") });
    expect(loginAttempt.status).toBe(401);
    expect(loginAttempt.body).toEqual({ error: "Invalid username or password" });
    // A session cannot be created for a deactivated user even by the service (login/deactivation race guard).
    expect(await createSession(getDb(env.DB), athleteId)).toBeNull();

    // Hidden by default, listed and flagged with ?include=deactivated.
    expect((await roster(team.owner)).athletes.map((a) => a.username)).toEqual(["athleteB"]);
    const full = await roster(team.owner, "?include=deactivated");
    expect(full.athletes.map((a) => [a.username, a.deactivatedAt !== null])).toEqual([["athleteA", true], ["athleteB", false]]);
    expect(full.athletes[0]?.deactivatedAt).toBe(deactivated.body.deactivatedAt);
    expect((await api("/api/coach/athletes?include=everything", { cookie: team.owner.cookie })).status).toBe(400);

    // Coach plan endpoints keep working and the data is still there.
    expect((await api(`/api/coach/athletes/${athleteId}/overview`, { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api(`/api/coach/athletes/${athleteId}/plan/sessions`, {
      method: "PUT", json: { dayKey: "mon", sessionType: "Range", detail: "Still coached", prescription: "60 arrows" }, cookie: team.owner.cookie,
    })).status).toBe(200);
    expect(await countRows("training_sessions", "user_id = ?", athleteId)).toBe(1);

    // Idempotent: the timestamp does not move.
    const again = await apiJson<AthleteStatus>(`/api/coach/athletes/${athleteId}/deactivate`, { method: "POST", cookie: team.owner.cookie });
    expect(again.status).toBe(200);
    expect(again.body.deactivatedAt).toBe(deactivated.body.deactivatedAt);

    // The username stays reserved (case-insensitively).
    expect((await tryAccept(await createInvite(team.owner), "athleteA")).status).toBe(409);
    expect((await tryAccept(await createInvite(team.owner), "ATHLETEA")).status).toBe(409);

    // Reactivate: login works again, session guard lifted, roster shows them.
    const reactivated = await apiJson<AthleteStatus>(`/api/coach/athletes/${athleteId}/reactivate`, { method: "POST", cookie: team.coach.cookie });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toEqual({ id: athleteId, username: "athleteA", createdAt: deactivated.body.createdAt, deactivatedAt: null });
    expect((await me(team.athleteA)).status).toBe(401); // old sessions stay revoked
    const back = await login("athleteA");
    expect((await me(back)).status).toBe(200);
    expect((await roster(team.owner)).athletes.map((a) => a.username)).toEqual(["athleteA", "athleteB"]);
    const tracker = await apiJson<{ sessions: Array<{ notes: string }> }>("/api/tracker", { cookie: back.cookie });
    expect(tracker.body.sessions.map((s) => s.notes)).toEqual(["keep me"]);
    // Idempotent reactivation.
    expect((await apiJson<AthleteStatus>(`/api/coach/athletes/${athleteId}/reactivate`, { method: "POST", cookie: team.coach.cookie })).body.deactivatedAt).toBeNull();
    expect((await me(back)).status).toBe(200);
  });

  it("only athletes can be targeted, only by coaches", async () => {
    const team = await setupTeam();
    expect((await api(`/api/coach/athletes/${team.coach.user.id}/deactivate`, { method: "POST", cookie: team.owner.cookie })).status).toBe(404);
    expect((await api(`/api/coach/athletes/${team.owner.user.id}/deactivate`, { method: "POST", cookie: team.coach.cookie })).status).toBe(404);
    expect((await api("/api/coach/athletes/nope/deactivate", { method: "POST", cookie: team.coach.cookie })).status).toBe(404);
    expect((await api(`/api/coach/athletes/${team.coach.user.id}/reactivate`, { method: "POST", cookie: team.owner.cookie })).status).toBe(404);
    expect((await api(`/api/coach/athletes/${team.athleteB.user.id}/deactivate`, { method: "POST", cookie: team.athleteA.cookie })).status).toBe(403);
    expect((await api(`/api/coach/athletes/${team.athleteB.user.id}/deactivate`, { method: "POST" })).status).toBe(401);
    expect(await countRows("users", "deactivated_at IS NOT NULL")).toBe(0);
    expect((await me(team.coach)).status).toBe(200);
  });
});

describe("POST /api/auth/owner/transfer", () => {
  it("moves ownership to an active coach and invalidates the old owner's pending coach invites", async () => {
    const team = await setupTeam();
    const oldOwnerCoachInvite = await createInvite(team.owner, { role: "coach" });
    const transferred = await apiJson("/api/auth/owner/transfer", { json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie });
    expect(transferred.status).toBe(200);
    expect(transferred.body).toEqual({ ok: true, previousOwnerId: team.owner.user.id, newOwnerId: team.coach.user.id });

    expect((await me(team.owner)).body).toMatchObject({ id: team.owner.user.id, isOwner: false, role: "coach" });
    expect((await me(team.coach)).body).toMatchObject({ id: team.coach.user.id, isOwner: true, role: "coach" });
    expect(await ownerCount()).toBe(1);
    expect((await userRow(team.coach.user.id))?.is_owner).toBe(1);

    // Owner-only abilities follow the flag.
    expect((await api("/api/auth/invites", { json: { role: "coach" }, cookie: team.owner.cookie })).status).toBe(403);
    expect((await api("/api/auth/invites", { json: { role: "coach" }, cookie: team.coach.cookie })).status).toBe(201);
    expect((await api("/api/coach/coaches", { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api("/api/coach/coaches", { cookie: team.owner.cookie })).status).toBe(403);
    expect((await tryAccept(oldOwnerCoachInvite, "lateCoach")).status).toBe(410);

    // The previous owner cannot transfer any more; the new owner can hand it back.
    expect((await api("/api/auth/owner/transfer", { json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie })).status).toBe(403);
    expect((await api("/api/auth/owner/transfer", { json: { coachId: team.owner.user.id, password: DEFAULT_PASSWORD }, cookie: team.coach.cookie })).status).toBe(200);
    expect((await me(team.owner)).body).toMatchObject({ isOwner: true });
    expect(await ownerCount()).toBe(1);
  });

  it("rejects invalid targets, wrong passwords and non-owners without changing ownership", async () => {
    const team = await setupTeam();
    const attempt = (json: unknown, session: Session = team.owner) => apiJson<{ error: string }>("/api/auth/owner/transfer", { json, cookie: session.cookie });
    expect((await attempt({ coachId: team.athleteA.user.id, password: DEFAULT_PASSWORD })).status).toBe(404);
    expect((await attempt({ coachId: "does-not-exist", password: DEFAULT_PASSWORD })).status).toBe(404);
    expect((await attempt({ coachId: team.owner.user.id, password: DEFAULT_PASSWORD })).status).toBe(400);
    const wrong = await attempt({ coachId: team.coach.user.id, password: "wrong-password" });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: "Incorrect password" });
    expect((await attempt({ coachId: team.owner.user.id, password: DEFAULT_PASSWORD }, team.coach)).status).toBe(403);
    expect((await attempt({ coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, team.athleteA)).status).toBe(403);
    expect((await attempt({ password: DEFAULT_PASSWORD })).status).toBe(400);
    // A deactivated coach row (not reachable through the API today) is not eligible either.
    await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE id = ?").bind(Date.now(), team.coach.user.id).run();
    expect((await attempt({ coachId: team.coach.user.id, password: DEFAULT_PASSWORD })).status).toBe(404);

    expect((await me(team.owner)).body).toMatchObject({ isOwner: true });
    expect(await ownerCount()).toBe(1);
    expect((await userRow(team.owner.user.id))?.is_owner).toBe(1);
  });

  it("concurrent transfers to two coaches leave exactly one owner and one winner", async () => {
    const team = await setupTeam();
    const coach3 = await acceptInvite(await createInvite(team.owner, { role: "coach" }), "coach3");
    const db = getDb(env.DB);
    // Both calls see the caller as owner and verify the password before
    // either batch runs (see the password-change race above).
    const [a, b] = await Promise.all([
      transferOwnership(db, team.owner.user.id, team.coach.user.id, DEFAULT_PASSWORD),
      transferOwnership(db, team.owner.user.id, coach3.user.id, DEFAULT_PASSWORD),
    ]);
    expect([a, b].sort()).toEqual(["conflict", "ok"]);
    const winner = a === "ok" ? team.coach : coach3;
    const loser = a === "ok" ? coach3 : team.coach;
    expect(await ownerCount()).toBe(1);
    expect((await userRow(winner.user.id))?.is_owner).toBe(1);
    expect((await userRow(loser.user.id))?.is_owner).toBe(0);
    expect((await me(team.owner)).body).toMatchObject({ isOwner: false });
    // Sequentially, the ex-owner is refused up front.
    expect((await api("/api/auth/owner/transfer", { json: { coachId: loser.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie })).status).toBe(403);
    expect(await ownerCount()).toBe(1);
  });

  it("a transfer and the target's deletion interleaved at the service level leave exactly one owner", async () => {
    const db = getDb(env.DB);
    for (const order of ["transfer-first", "delete-first"] as const) {
      await resetStorage();
      const team = await setupTeam();
      const transfer = () => transferOwnership(db, team.owner.user.id, team.coach.user.id, DEFAULT_PASSWORD);
      const remove = () => deleteAccount(db, team.coach.user.id, DEFAULT_PASSWORD);
      const [t, d] = order === "transfer-first" ? await Promise.all([transfer(), remove()]) : (await Promise.all([remove(), transfer()])).reverse() as [Awaited<ReturnType<typeof transfer>>, Awaited<ReturnType<typeof remove>>];
      expect(await ownerCount(), order).toBe(1);
      const coachRow = await userRow(team.coach.user.id);
      if (t === "ok") {
        expect(d.status, order).toBe("owner");
        expect(coachRow?.is_owner, order).toBe(1);
      } else {
        expect(t, order).toBe("conflict");
        expect(d.status, order).toBe("ok");
        expect(coachRow, order).toBeNull();
        expect((await userRow(team.owner.user.id))?.is_owner, order).toBe(1);
      }
    }
  });

  it("a transfer racing the target's account deletion never leaves zero or two owners", async () => {
    const team = await setupTeam();
    const [transfer, deletion] = await Promise.all([
      apiJson("/api/auth/owner/transfer", { json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD }, cookie: team.owner.cookie }),
      apiJson("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.coach.cookie }),
    ]);
    expect(await ownerCount()).toBe(1);
    const coachRow = await userRow(team.coach.user.id);
    if (transfer.status === 200) {
      // Transfer won: the coach is the owner and their deletion was refused.
      expect(coachRow?.is_owner).toBe(1);
      expect(deletion.status).toBe(409);
      expect((await userRow(team.owner.user.id))?.is_owner).toBe(0);
    } else {
      // Deletion won: the target vanished, the transfer conflicted, ownership stayed put.
      expect(transfer.status).toBe(409);
      expect(deletion.status).toBe(200);
      expect(coachRow).toBeNull();
      expect((await userRow(team.owner.user.id))?.is_owner).toBe(1);
    }
    // Any follow-up sequence keeps the invariant.
    const coach4 = await acceptInvite(await createInvite(await login(transfer.status === 200 ? "coach2" : "owner"), { role: "coach" }), "coach4");
    const currentOwner = transfer.status === 200 ? await login("coach2") : team.owner;
    expect((await api("/api/auth/owner/transfer", { json: { coachId: coach4.user.id, password: DEFAULT_PASSWORD }, cookie: currentOwner.cookie })).status).toBe(200);
    expect((await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: currentOwner.cookie })).status).toBe(200);
    expect(await ownerCount()).toBe(1);
    expect((await userRow(coach4.user.id))?.is_owner).toBe(1);
  });
});
