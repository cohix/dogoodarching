import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { runScheduledCleanup } from "../../src/services/cleanup";
import { countRows, setupTeam, userRow } from "./auth-fixtures";
import { api, bootstrapTeam, DEFAULT_PASSWORD } from "./helpers";
import { ACCOUNT_TABLES, accountSnapshot, seedAccountData } from "./security-auth-fixtures";

it("account deletion cascades every populated account table, preserves another account, and retries R2 after the user is gone", async () => {
  const { coach, athlete } = await bootstrapTeam();
  const key = await seedAccountData(athlete.user.id, 801);
  const preservedKey = await seedAccountData(coach.user.id, 802);
  const preserved = await accountSnapshot(coach.user.id);
  const populated = await accountSnapshot(athlete.user.id);
  for (const table of ACCOUNT_TABLES) expect(populated[table]!.length, `${table} must actually be populated`).toBeGreaterThan(0);
  const originalBucket = env.ATTACHMENTS;
  const remove = vi.fn(async () => {
    throw new Error("forced R2 failure");
  });
  env.ATTACHMENTS = new Proxy(originalBucket, { get(target, property) {
    if (property === "delete") return remove;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    const response = await api("/api/auth/account", { method: "DELETE", cookie: athlete.cookie, json: { password: DEFAULT_PASSWORD } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    // SELF's background task runs in another I/O context. Wait for its durable
    // completion marker; no assertion relies on how much real time passes.
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT attempts FROM blob_cleanup WHERE blob_key = ?").bind(key).first()).toEqual({ attempts: 1 });
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    expect(await userRow(athlete.user.id)).toBeNull();
    for (const table of ACCOUNT_TABLES) expect(await countRows(table, "user_id = ?", athlete.user.id), table).toBe(0);
    expect(await accountSnapshot(coach.user.id)).toEqual(preserved);
    expect((await api("/api/auth/me", { cookie: athlete.cookie })).status).toBe(401);
    expect(await env.ATTACHMENTS.head(key)).not.toBeNull();
    const queued = await env.DB.prepare("SELECT attempts,next_attempt_at FROM blob_cleanup WHERE blob_key = ?").bind(key).first<{ attempts: number; next_attempt_at: number }>();
    expect(queued!.attempts).toBe(1);
    env.ATTACHMENTS = originalBucket;
    // Retry exactly at the persisted deadline; no dependence on elapsed time.
    const report = await runScheduledCleanup(env, new Date(queued!.next_attempt_at));
    expect(report.blobs).toEqual({ deleted: 1, failed: 0, skippedReferenced: 0 });
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect(await env.ATTACHMENTS.head(preservedKey)).not.toBeNull();
    expect(await countRows("blob_cleanup")).toBe(0);
    expect((await runScheduledCleanup(env, new Date(queued!.next_attempt_at))).blobs.deleted).toBe(0);
  } finally {
    env.ATTACHMENTS = originalBucket;
  }
});

it("a failed account deletion batch keeps every data row and file and rolls back its cleanup record", async () => {
  const { athlete } = await bootstrapTeam();
  const key = await seedAccountData(athlete.user.id, 811);
  const before = await accountSnapshot(athlete.user.id);
  await env.DB.prepare("CREATE TRIGGER security_refuse_delete BEFORE DELETE ON users WHEN OLD.username = 'athlete' BEGIN SELECT RAISE(ABORT, 'forced deletion rollback'); END").run();
  try {
    const result = await api("/api/auth/account", { method: "DELETE", cookie: athlete.cookie, json: { password: DEFAULT_PASSWORD } });
    expect(result.status).toBe(500);
    expect(await accountSnapshot(athlete.user.id)).toEqual(before);
    expect(await userRow(athlete.user.id)).not.toBeNull();
    expect(await countRows("blob_cleanup")).toBe(0);
    expect(await (await env.ATTACHMENTS.get(key))!.text()).toBe("private bytes");
    expect((await api("/api/auth/me", { cookie: athlete.cookie })).status).toBe(200);
  } finally { await env.DB.prepare("DROP TRIGGER security_refuse_delete").run(); }
});

it("deleting a non-owner coach preserves every populated athlete table and their R2 file", async () => {
  const team = await setupTeam();
  const key = await seedAccountData(team.athleteB.user.id, 821);
  const before = await accountSnapshot(team.athleteB.user.id);
  expect((await userRow(team.athleteB.user.id))!.invited_by).toBe(team.coach.user.id);
  const response = await api("/api/auth/account", { method: "DELETE", cookie: team.coach.cookie, json: { password: DEFAULT_PASSWORD } });
  expect(response.status).toBe(200);
  expect(await userRow(team.coach.user.id)).toBeNull();
  expect(await accountSnapshot(team.athleteB.user.id)).toEqual(before);
  expect((await userRow(team.athleteB.user.id))!.invited_by).toBeNull();
  expect(await (await env.ATTACHMENTS.get(key))!.text()).toBe("private bytes");
});
