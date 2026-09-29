// Rate limiting through Workers Rate Limiting bindings (src/lib/rate-limit.ts).
//
// vitest.config.ts injects the test-only `RATE_LIMIT_MODE = "allow"` binding
// so every other suite can log in freely. `env` from cloudflare:test is the
// same object the Worker receives, so a test switches the mock by assigning
// `env.RATE_LIMIT_MODE` ("deny", "deny:<key prefix>" or "error"); `afterEach`
// restores "allow". Unit tests below hand `checkRateLimit` a hand-built `Env`
// to exercise the real binding selection, missing-binding and error paths.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env, RateLimitBinding } from "../../src/db";
import {
  RATE_LIMITED_MESSAGE,
  RATE_LIMIT_RULES,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
  checkRateLimit,
  normalizeUsername,
  rateLimitKey,
} from "../../src/lib/rate-limit";
import { countRows, credentials } from "./auth-fixtures";
import { api, apiJson, bootstrapCoach, login } from "./helpers";

afterEach(() => {
  env.RATE_LIMIT_MODE = "allow";
});

/** A binding that records the keys it was asked about and answers `success`. */
function recorder(success: boolean): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } };
}

/** Env without the mock switch, so `checkRateLimit` uses the real binding path. */
function envWith(bindings: Partial<Pick<Env, "RATE_LIMIT_5_PER_MIN" | "RATE_LIMIT_10_PER_MIN">>): Env {
  return { DB: env.DB, ATTACHMENTS: env.ATTACHMENTS, ...bindings };
}

describe("checkRateLimit (binding selection, fail closed)", () => {
  it("selects the 5/min or 10/min binding per operation and prefixes the key", async () => {
    const five = recorder(true);
    const ten = recorder(true);
    const e = envWith({ RATE_LIMIT_5_PER_MIN: five, RATE_LIMIT_10_PER_MIN: ten });
    expect(await checkRateLimit(e, "login-ip", "1.2.3.4")).toBe("allowed");
    expect(await checkRateLimit(e, "login-user", "coach")).toBe("allowed");
    expect(await checkRateLimit(e, "bootstrap", "1.2.3.4")).toBe("allowed");
    expect(await checkRateLimit(e, "accept-invite", "1.2.3.4")).toBe("allowed");
    expect(await checkRateLimit(e, "invite-create", "user-1")).toBe("allowed");
    expect(await checkRateLimit(e, "upload", "user-1")).toBe("allowed");
    expect(await checkRateLimit(e, "password-verify", "user-1")).toBe("allowed");
    expect(ten.keys).toEqual(["login:1.2.3.4", "accept-invite:1.2.3.4", "invite-create:user-1", "upload:user-1"]);
    expect(five.keys).toEqual(["login-user:coach", "bootstrap:1.2.3.4", "password-verify:user-1"]);
    for (const [operation, rule] of Object.entries(RATE_LIMIT_RULES)) {
      expect(rule.binding, operation).toBe(rule.perMinute === 5 ? "RATE_LIMIT_5_PER_MIN" : "RATE_LIMIT_10_PER_MIN");
    }
  });

  it("reports a denial from the binding", async () => {
    const e = envWith({ RATE_LIMIT_5_PER_MIN: recorder(false), RATE_LIMIT_10_PER_MIN: recorder(false) });
    expect(await checkRateLimit(e, "login-ip", "x")).toBe("denied");
    expect(await checkRateLimit(e, "login-user", "x")).toBe("denied");
  });

  it("fails closed when the binding is missing or throws", async () => {
    expect(await checkRateLimit(envWith({}), "login-ip", "x")).toBe("unavailable");
    expect(await checkRateLimit(envWith({ RATE_LIMIT_5_PER_MIN: recorder(true) }), "login-ip", "x")).toBe("unavailable");
    const throwing: RateLimitBinding = { limit: async () => { throw new Error("boom"); } };
    expect(await checkRateLimit(envWith({ RATE_LIMIT_10_PER_MIN: throwing }), "login-ip", "x")).toBe("unavailable");
  });

  it("an unknown RATE_LIMIT_MODE also fails closed", async () => {
    expect(await checkRateLimit({ ...envWith({ RATE_LIMIT_10_PER_MIN: recorder(true) }), RATE_LIMIT_MODE: "off" }, "login-ip", "x")).toBe("unavailable");
  });

  it("normalizes usernames for the per-user login key", () => {
    expect(rateLimitKey("login-user", normalizeUsername("  CoAcH "))).toBe("login-user:coach");
  });
});

describe("rate limiting on the auth routes (RATE_LIMIT_MODE mock)", () => {
  it("returns 429 with an { error } body when the binding denies, before the body is parsed", async () => {
    env.RATE_LIMIT_MODE = "deny";
    for (const path of ["/api/auth/bootstrap", "/api/auth/login", "/api/auth/accept-invite"]) {
      const { status, body } = await apiJson(path, { json: credentials("owner") });
      expect(status, path).toBe(429);
      expect(body).toEqual({ error: RATE_LIMITED_MESSAGE });
    }
    expect((await api("/api/auth/bootstrap", { body: "not json", headers: { "content-type": "text/plain" } })).status).toBe(429);
    expect(await countRows("users")).toBe(0);
  });

  it("login checks the per-IP key and then the normalized per-username key", async () => {
    await bootstrapCoach("Owner");
    // Only the per-username key is denied: bootstrap/accept-invite (per IP) still pass.
    env.RATE_LIMIT_MODE = "deny:login-user:owner";
    const denied = await apiJson("/api/auth/login", { json: credentials("OWNER") });
    expect(denied.status).toBe(429);
    expect(denied.body).toEqual({ error: RATE_LIMITED_MESSAGE });
    expect((await api("/api/auth/login", { json: credentials("someone-else") })).status).toBe(401);
    expect((await api("/api/auth/accept-invite", { json: { token: "x", username: "abc", password: "password-1" } })).status).toBe(400);
    // The per-username check runs after validation: an invalid body is still 400.
    expect((await api("/api/auth/login", { json: { username: "OWNER" } })).status).toBe(400);
    // Only the per-IP key is denied: the username key is never reached.
    env.RATE_LIMIT_MODE = "deny:login:";
    expect((await api("/api/auth/login", { json: credentials("Owner") })).status).toBe(429);
    env.RATE_LIMIT_MODE = "allow";
    expect((await api("/api/auth/login", { json: credentials("Owner") })).status).toBe(200);
  });

  it("invite creation is limited per acting coach", async () => {
    const owner = await bootstrapCoach("owner");
    env.RATE_LIMIT_MODE = `deny:invite-create:${owner.user.id}`;
    const { status, body } = await apiJson("/api/auth/invites", { json: {}, cookie: owner.cookie });
    expect(status).toBe(429);
    expect(body).toEqual({ error: RATE_LIMITED_MESSAGE });
    expect(await countRows("invites")).toBe(0);
    env.RATE_LIMIT_MODE = "deny:invite-create:someone-else";
    expect((await api("/api/auth/invites", { json: {}, cookie: owner.cookie })).status).toBe(201);
  });

  it("fails closed with a generic 503 { error } when the binding errors or is unavailable", async () => {
    await bootstrapCoach("owner");
    for (const mode of ["error", "not-a-mode"]) {
      env.RATE_LIMIT_MODE = mode;
      const { status, body } = await apiJson("/api/auth/login", { json: credentials("owner") });
      expect(status, mode).toBe(503);
      expect(body).toEqual({ error: RATE_LIMIT_UNAVAILABLE_MESSAGE });
    }
    env.RATE_LIMIT_MODE = "allow";
    expect((await login("owner")).user.username).toBe("owner");
  });

  it("the D1 rate_limits table no longer exists after migrations", async () => {
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limits'").first();
    expect(row).toBeNull();
  });
});
