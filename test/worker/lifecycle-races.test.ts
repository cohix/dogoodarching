import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/auth";
import { countRows, setupTeam, userRow } from "./auth-fixtures";
import { acceptInvite, api, bootstrapTeam, createInvite, DEFAULT_PASSWORD, sessionCookie } from "./helpers";
import { interceptD1, rendezvous } from "./security-auth-fixtures";

it("auth middleware refuses a deactivated athlete even if a valid session row survives", async () => {
  const { coach, athlete } = await bootstrapTeam();
  expect((await api(`/api/coach/athletes/${athlete.user.id}/deactivate`, { method: "POST", cookie: coach.cookie })).status).toBe(200);
  await env.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,expires_at,created_at) VALUES ('survivor',?,?,?,?)")
    .bind(await sha256Hex("surviving-token"), athlete.user.id, Date.now() + 86400000, Date.now()).run();
  expect(await countRows("sessions", "user_id = ?", athlete.user.id)).toBe(1);
  expect((await api("/api/auth/me", { cookie: "dga_session=surviving-token" })).status).toBe(401);
});

it("login paused before session creation cannot survive deactivation or be revived by later reactivation", async () => {
  const { coach, athlete } = await bootstrapTeam();
  const realDb = env.DB;
  const paused = rendezvous();
  const resume = rendezvous();
  let gated = false;
  env.DB = interceptD1(realDb, async (sql, phase) => {
    if (!gated && phase === "before" && /INSERT INTO sessions/i.test(sql)) {
      gated = true;
      paused.release();
      await resume.reached;
    }
  });
  const pending = api("/api/auth/login", { json: { username: athlete.user.username, password: DEFAULT_PASSWORD } });
  try {
    await paused.reached;
    expect((await api(`/api/coach/athletes/${athlete.user.id}/deactivate`, { method: "POST", cookie: coach.cookie })).status).toBe(200);
    resume.release();
    const result = await pending;
    expect(result.status).toBe(401);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(await countRows("sessions", "user_id = ?", athlete.user.id)).toBe(0);
    expect((await api(`/api/coach/athletes/${athlete.user.id}/reactivate`, { method: "POST", cookie: coach.cookie })).status).toBe(200);
    expect((await api("/api/auth/me", { cookie: athlete.cookie })).status).toBe(401);
    expect(await countRows("sessions", "user_id = ?", athlete.user.id)).toBe(0);
  } finally {
    resume.release();
    await pending;
    env.DB = realDb;
  }
});

it("two HTTP transfers that both finish their prechecks leave one winner and exactly one owner", async () => {
  const team = await setupTeam();
  const third = await acceptInvite(await createInvite(team.owner, { role: "coach" }), "third");
  const realDb = env.DB;
  const bothReady = rendezvous();
  let arrivals = 0;
  env.DB = interceptD1(realDb, async (sql, phase) => {
    if (phase === "before" && /^update "users" set "is_owner"/i.test(sql)) {
      arrivals++;
      if (arrivals === 2) bothReady.release();
      await bothReady.reached;
    }
  });
  try {
    const responses = await Promise.all([team.coach, third].map(target => api("/api/auth/owner/transfer", {
      cookie: team.owner.cookie, json: { coachId: target.user.id, password: DEFAULT_PASSWORD },
    })));
    expect(arrivals).toBe(2);
    expect(responses.map(r => r.status).sort()).toEqual([200,409]);
    expect(await countRows("users", "is_owner = 1")).toBe(1);
    const winner = responses[0]!.status === 200 ? team.coach : third;
    expect((await userRow(winner.user.id))!.is_owner).toBe(1);
    expect(await (await api("/api/auth/me", { cookie: winner.cookie })).json()).toMatchObject({ isOwner: true });
    expect(await (await api("/api/auth/me", { cookie: team.owner.cookie })).json()).toMatchObject({ isOwner: false });
  } finally { env.DB = realDb; }
});

it.each(["transfer", "delete"])("HTTP transfer/target-deletion after both prechecks, %s commits first, leaves exactly one owner", async first => {
  const team = await setupTeam();
  const realDb = env.DB;
  const ready = rendezvous();
  const firstCommitted = rendezvous();
  let arrivals = 0;
  env.DB = interceptD1(realDb, async (sql, phase) => {
    const operation = /^update "users" set "is_owner"/i.test(sql) ? "transfer" : /delete from "users"/i.test(sql) ? "delete" : null;
    if (!operation) return;
    if (phase === "before") {
      if (++arrivals === 2) ready.release();
      await ready.reached;
      if (operation !== first) await firstCommitted.reached;
    } else if (operation === first) firstCommitted.release();
  });
  try {
    const [transfer, deletion] = await Promise.all([
      api("/api/auth/owner/transfer", { cookie: team.owner.cookie, json: { coachId: team.coach.user.id, password: DEFAULT_PASSWORD } }),
      api("/api/auth/account", { method: "DELETE", cookie: team.coach.cookie, json: { password: DEFAULT_PASSWORD } }),
    ]);
    expect(arrivals).toBe(2);
    expect([transfer.status, deletion.status]).toEqual(first === "transfer" ? [200,409] : [409,200]);
    expect(await countRows("users", "is_owner = 1")).toBe(1);
    expect((await userRow(team.owner.user.id))!.is_owner).toBe(first === "transfer" ? 0 : 1);
    if (first === "delete") expect(await userRow(team.coach.user.id)).toBeNull();
    else expect((await userRow(team.coach.user.id))!.is_owner).toBe(1);
  } finally { env.DB = realDb; }
});

it("two password changes with the same verified hash keep only the winning request's session", async () => {
  const { athlete } = await bootstrapTeam();
  const second = await api("/api/auth/login", { json: { username: athlete.user.username, password: DEFAULT_PASSWORD } });
  const cookies = [athlete.cookie, sessionCookie(second)];
  const realDb = env.DB;
  const ready = rendezvous();
  let arrivals = 0;
  env.DB = interceptD1(realDb, async (sql, phase) => {
    if (phase === "before" && /^update "users" set "password_hash"/i.test(sql)) {
      if (++arrivals === 2) ready.release();
      await ready.reached;
    }
  });
  try {
    const results = await Promise.all(cookies.map((cookie, i) => api("/api/auth/password", { cookie, json: { currentPassword: DEFAULT_PASSWORD, newPassword: `new-password-${i}` } })));
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    expect(await countRows("sessions", "user_id = ?", athlete.user.id)).toBe(1);
    for (let i = 0; i < 2; i++) expect((await api("/api/auth/me", { cookie: cookies[i] })).status).toBe(results[i]!.status === 200 ? 200 : 401);
  } finally { env.DB = realDb; }
});
