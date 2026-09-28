// The D1-backed fixed-window rate limiter that guards bootstrap, login,
// accept-invite and invite creation. Work item 0002 replaces it with the
// Workers Rate Limiting binding, but 0001 requires "no 500" under concurrent
// bootstrap / accept-invite, and the limiter is on that path.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db";
import { checkRateLimit } from "../../src/lib/rate-limit";
import { countRows, credentials, warmRateLimit } from "./auth-fixtures";
import { api, bootstrapCoach } from "./helpers";

describe("checkRateLimit", () => {
  it("counts sequential attempts and blocks the (max+1)th", async () => {
    const db = getDb(env.DB);
    for (let i = 0; i < 3; i++) expect(await checkRateLimit(db, "k", 3, 60_000)).toBe(true);
    expect(await checkRateLimit(db, "k", 3, 60_000)).toBe(false);
    expect(await countRows("rate_limits", "key = 'k' AND attempts = 3")).toBe(1);
    // A different key is independent.
    expect(await checkRateLimit(db, "other", 3, 60_000)).toBe(true);
  });

  it("forgets a bucket once its window has passed", async () => {
    const db = getDb(env.DB);
    for (let i = 0; i < 2; i++) await checkRateLimit(db, "k", 2, 60_000);
    expect(await checkRateLimit(db, "k", 2, 60_000)).toBe(false);
    await env.DB.prepare("UPDATE rate_limits SET window_start = ? WHERE key = 'k'").bind(Date.now() - 61_000).run();
    expect(await checkRateLimit(db, "k", 2, 60_000)).toBe(true);
  });

  it("survives concurrent first attempts on a fresh key without throwing", async () => {
    // A fresh bucket admits the whole allowed burst without uniqueness errors.
    const db = getDb(env.DB);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => checkRateLimit(db, "fresh", 100, 60_000)));
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(results.every((r) => r.status === "fulfilled" && r.value === true)).toBe(true);
    expect(await countRows("rate_limits", "key = 'fresh' AND attempts = 8")).toBe(1);
  });
});

describe("rate limiting on the public auth routes", () => {
  it("the first concurrent burst of requests never yields a 500", async () => {
    await bootstrapCoach("owner");
    // Cheap requests: they fail validation right after the limiter ran, so no
    // PBKDF2 is involved and the SELECT/INSERT windows overlap tightly.
    const responses = await Promise.all(Array.from({ length: 8 }, () => api("/api/auth/accept-invite", { json: {} })));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(400));
    expect(await countRows("rate_limits", "key LIKE 'accept-invite:%'")).toBe(1);
  });

  it("bootstrap is limited to 10 attempts per IP per hour, counting invalid bodies", async () => {
    for (let i = 0; i < 10; i++) expect((await api("/api/auth/bootstrap", { json: {} })).status).toBe(400);
    const blocked = await api("/api/auth/bootstrap", { json: credentials("owner") });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: expect.any(String) });
    expect(await countRows("users")).toBe(0);
  });

  it("login is limited to 20 attempts per IP per 10 minutes", async () => {
    await bootstrapCoach("owner");
    await warmRateLimit("/api/auth/login");
    for (let i = 0; i < 19; i++) expect((await api("/api/auth/login", { json: { username: "owner", password: "wrong-password" } })).status).toBe(401);
    expect((await api("/api/auth/login", { json: credentials("owner") })).status).toBe(429);
  });

  it("invite creation is limited per coach, not per IP", async () => {
    const owner = await bootstrapCoach("owner");
    for (let i = 0; i < 20; i++) expect((await api("/api/auth/invites", { json: {}, cookie: owner.cookie })).status).toBe(201);
    expect((await api("/api/auth/invites", { json: {}, cookie: owner.cookie })).status).toBe(429);
    expect(await countRows("rate_limits", "key = ?", `invite-create:${owner.user.id}`)).toBe(1);
    expect(await countRows("invites")).toBe(20);
  });
});

it.each(["fresh", "existing", "expired"])("admits exactly the allowance for a concurrent %s bucket", async (state) => {
  const db = getDb(env.DB);
  if (state !== "fresh") await checkRateLimit(db, "burst", 5, 60_000);
  if (state === "expired") await env.DB.prepare("UPDATE rate_limits SET window_start = ? WHERE key = 'burst'").bind(Date.now() - 60_001).run();
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => checkRateLimit(db, "burst", 5, 60_000)));
  expect(outcomes.filter(Boolean)).toHaveLength(state === "existing" ? 4 : 5);
  expect(await countRows("rate_limits", "key = 'burst' AND attempts = 5")).toBe(1);
});
it("a short-window request does not reset another key's longer window", async () => {
  const db = getDb(env.DB);
  await checkRateLimit(db, "hour", 1, 3_600_000);
  await env.DB.prepare("UPDATE rate_limits SET window_start = ? WHERE key = 'hour'").bind(Date.now() - 120_000).run();
  await checkRateLimit(db, "minute", 1, 60_000);
  expect(await checkRateLimit(db, "hour", 1, 3_600_000)).toBe(false);
});
