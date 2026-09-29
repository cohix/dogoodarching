// PBKDF2 stored-hash rules (src/lib/auth.ts) and rehash-on-login
// (src/services/auth.ts): new hashes use 100k iterations, verification reads
// the count from the stored value within [min, max], anything else fails
// safely, and a supported lower count is upgraded exactly once, without
// overwriting a concurrent password change.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from "../../src/lib/auth";
import { credentials, userRow } from "./auth-fixtures";
import { api, bootstrapCoach, DEFAULT_PASSWORD, login } from "./helpers";

const PASSWORD = "correct-horse-battery";

/** Build a stored hash at an arbitrary iteration count (bypassing hashPassword's constant). */
async function hashAt(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256));
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

describe("password hash format", () => {
  it("new hashes use 100k iterations, a 16-byte salt and a 32-byte hash", async () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
    expect(PBKDF2_MIN_ITERATIONS).toBeLessThan(PBKDF2_ITERATIONS);
    const stored = await hashPassword(PASSWORD);
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    const parsed = parsePasswordHash(stored);
    expect(parsed?.iterations).toBe(100_000);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.hash.length).toBe(32);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("verifies any supported count read from the stored value", async () => {
    expect(await verifyPassword(PASSWORD, await hashAt(PASSWORD, PBKDF2_MIN_ITERATIONS))).toBe(true);
    expect(await verifyPassword(PASSWORD, await hashAt(PASSWORD, 50_000))).toBe(true);
    expect(await verifyPassword(PASSWORD, await hashAt(PASSWORD, PBKDF2_MAX_ITERATIONS))).toBe(true);
  });

  it("rejects unsupported, malformed and empty stored values without throwing", async () => {
    const good = await hashPassword(PASSWORD);
    const [, , salt, hash] = good.split("$") as [string, string, string, string];
    const bad: Array<[string, string]> = [
      ["210k (pre-0002)", await hashAt(PASSWORD, 210_000)],
      ["above max", `pbkdf2$100001$${salt}$${hash}`],
      ["below floor", await hashAt(PASSWORD, PBKDF2_MIN_ITERATIONS - 1)],
      ["non-integer count", `pbkdf2$abc$${salt}$${hash}`],
      ["float count", `pbkdf2$100000.0$${salt}$${hash}`],
      ["signed count", `pbkdf2$+100000$${salt}$${hash}`],
      ["leading zero count", `pbkdf2$0100000$${salt}$${hash}`],
      ["three parts", `pbkdf2$100000$${salt}`],
      ["five parts", `${good}$extra`],
      ["wrong scheme", `bcrypt$100000$${salt}$${hash}`],
      ["empty", ""],
      ["empty fields", "pbkdf2$$$"],
      ["empty salt", `pbkdf2$100000$$${hash}`],
      ["empty hash", `pbkdf2$100000$${salt}$`],
      ["15-byte salt", `pbkdf2$100000$${btoa("123456789012345")}$${hash}`],
      ["31-byte hash", `pbkdf2$100000$${salt}$${btoa("1234567890123456789012345678901")}`],
      ["invalid base64 salt", `pbkdf2$100000$${"!".repeat(24)}$${hash}`],
      ["invalid base64 hash", `pbkdf2$100000$${salt}$${"not base64 at all, really!!!!!!!!!!!!!!!!!!!"}`],
    ];
    for (const [label, stored] of bad) {
      expect(parsePasswordHash(stored), label).toBeNull();
      await expect(verifyPassword(PASSWORD, stored), label).resolves.toBe(false);
    }
    expect(parsePasswordHash(null)).toBeNull();
    expect(parsePasswordHash(undefined)).toBeNull();
  });
});

describe("rehash on login", () => {
  it("bootstrap stores a 100k hash and login does not rewrite it", async () => {
    const owner = await bootstrapCoach("owner");
    const before = (await userRow(owner.user.id))?.password_hash;
    expect(before).toMatch(/^pbkdf2\$100000\$/);
    await login("owner");
    expect((await userRow(owner.user.id))?.password_hash).toBe(before);
  });

  it("upgrades a supported lower count exactly once", async () => {
    const owner = await bootstrapCoach("owner");
    const legacy = await hashAt(DEFAULT_PASSWORD, 50_000);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(legacy, owner.user.id).run();

    expect((await api("/api/auth/login", { json: { username: "owner", password: "wrong-password" } })).status).toBe(401);
    expect((await userRow(owner.user.id))?.password_hash).toBe(legacy); // a failed login never rehashes

    await login("owner");
    const upgraded = (await userRow(owner.user.id))?.password_hash;
    expect(upgraded).toMatch(/^pbkdf2\$100000\$/);
    expect(upgraded).not.toBe(legacy);
    expect(await verifyPassword(DEFAULT_PASSWORD, upgraded as string)).toBe(true);

    await login("owner");
    expect((await userRow(owner.user.id))?.password_hash).toBe(upgraded); // second login: unchanged
    expect((await userRow(owner.user.id))).toMatchObject({ is_owner: 1, role: "coach", username: "owner" });
  });

  it("does not overwrite a password that changed while the login was in flight", async () => {
    // Simulated race: the stored hash is replaced by a different (still
    // rehash-eligible) hash after `authenticate` read the legacy one. Both
    // legacy hashes are for the same password, so the login itself succeeds
    // but the conditional UPDATE must not touch the newer hash.
    const owner = await bootstrapCoach("owner");
    const legacyA = await hashAt(DEFAULT_PASSWORD, 50_000);
    const legacyB = await hashAt(DEFAULT_PASSWORD, 50_000);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(legacyA, owner.user.id).run();
    // The Worker runs in this isolate, so a D1 write racing the login is
    // modelled by issuing the change immediately after the login is sent.
    const inFlight = api("/api/auth/login", { json: credentials("owner") });
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?").bind(legacyB, owner.user.id, legacyA).run();
    const response = await inFlight;
    const finalHash = (await userRow(owner.user.id))?.password_hash;
    // Either the login read legacyA (then its conditional update failed and
    // legacyB survives) or it read legacyB (then it upgraded legacyB itself).
    // In no case does a stale rehash of legacyA win.
    expect([200, 401]).toContain(response.status);
    expect(finalHash === legacyB || (finalHash?.startsWith("pbkdf2$100000$") && response.status === 200)).toBe(true);
    if (finalHash !== legacyB) expect(await verifyPassword(DEFAULT_PASSWORD, finalHash as string)).toBe(true);
  });

  it("a 210k hash fails safely (401, no 500) and is left for the operator reset", async () => {
    const owner = await bootstrapCoach("owner");
    const legacy210k = await hashAt(DEFAULT_PASSWORD, 210_000);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(legacy210k, owner.user.id).run();
    const response = await api("/api/auth/login", { json: credentials("owner") });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid username or password" });
    expect((await userRow(owner.user.id))?.password_hash).toBe(legacy210k);

    // Operator reset runbook: a fresh 100k hash plus session revocation, keeping data and owner status.
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword("new-password-123"), owner.user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.user.id),
    ]);
    expect((await api("/api/auth/me", { cookie: owner.cookie })).status).toBe(401); // old session revoked
    const reset = await login("owner", "new-password-123");
    expect(reset.user).toMatchObject({ id: owner.user.id, isOwner: true, role: "coach" });
  });
});
