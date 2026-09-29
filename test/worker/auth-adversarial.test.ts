import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/lib/auth";
import { credentials, userRow } from "./auth-fixtures";
import { acceptInvite, api, bootstrapCoach, createInvite, DEFAULT_PASSWORD, login } from "./helpers";
import { accountSnapshot, interceptD1, rendezvous, seedAccountData } from "./security-auth-fixtures";

async function lowerHash() {
  const salt = new Uint8Array(16).fill(17);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DEFAULT_PASSWORD), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$10000$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}

describe("PBKDF2 through HTTP and real D1", () => {
  it("invite acceptance stores the 100k format and subsequent login preserves it", async () => {
    const owner = await bootstrapCoach();
    const athlete = await acceptInvite(await createInvite(owner), "accepted");
    const hash = (await userRow(athlete.user.id))!.password_hash;
    expect(hash).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    expect((await login("accepted")).user.id).toBe(athlete.user.id);
    expect((await userRow(athlete.user.id))!.password_hash).toBe(hash);
  });

  it.each(["", "pbkdf2$$$", "pbkdf2$100000$$", "pbkdf2$210000$SALT$HASH", "pbkdf2$NaN$SALT$HASH", "pbkdf2$9999$SALT$HASH", "pbkdf2$100000$!!!!$!!!!"])("stored %j returns generic 401, never a 500 or session", async stored => {
    const owner = await bootstrapCoach();
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(stored, owner.user.id).run();
    const before = await accountSnapshot(owner.user.id);
    const response = await api("/api/auth/login", { json: credentials(owner.user.username) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid username or password" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await accountSnapshot(owner.user.id)).toEqual(before);
    expect((await userRow(owner.user.id))!.password_hash).toBe(stored);
  });

  it("a login rehash cannot overwrite POST /password after verification of the old hash", async () => {
    const owner = await bootstrapCoach();
    const realDb = env.DB;
    await realDb.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await lowerHash(), owner.user.id).run();
    const paused = rendezvous();
    const resume = rendezvous();
    let gated = false;
    env.DB = interceptD1(realDb, async (sql, phase) => {
      if (!gated && phase === "before" && /^update "users" set "password_hash"/i.test(sql)) {
        gated = true;
        paused.release();
        await resume.reached;
      }
    });
    const pendingLogin = api("/api/auth/login", { json: credentials(owner.user.username) });
    try {
      await paused.reached;
      const changed = await api("/api/auth/password", { cookie: owner.cookie, json: { currentPassword: DEFAULT_PASSWORD, newPassword: "distinct-new-password" } });
      expect(changed.status).toBe(200);
      const newHash = (await userRow(owner.user.id))!.password_hash;
      resume.release();
      const staleLogin = await pendingLogin;
      expect(staleLogin.status).toBe(401);
      expect(staleLogin.headers.get("set-cookie")).toBeNull();
      expect((await realDb.prepare("SELECT id FROM sessions WHERE user_id = ?").bind(owner.user.id).all()).results).toHaveLength(1);
      expect((await userRow(owner.user.id))!.password_hash).toBe(newHash);
      expect(await verifyPassword("distinct-new-password", newHash)).toBe(true);
      expect((await api("/api/auth/login", { json: credentials(owner.user.username) })).status).toBe(401);
      expect((await login(owner.user.username, "distinct-new-password")).user.id).toBe(owner.user.id);
    } finally {
      resume.release();
      await pendingLogin;
      env.DB = realDb;
    }
  });

  it("the operator SQL reset preserves every data row, blob, identity and ownership and revokes all sessions", async () => {
    const owner = await bootstrapCoach();
    await login(owner.user.username);
    const key = await seedAccountData(owner.user.id, 901);
    const legacy = (await hashPassword(DEFAULT_PASSWORD)).replace("$100000$", "$210000$");
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(legacy, owner.user.id).run();
    const before = await accountSnapshot(owner.user.id);
    const identity = await userRow(owner.user.id);
    const resetHash = await hashPassword("operator-reset-password");
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(resetHash, owner.user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.user.id),
    ]);
    expect(await accountSnapshot(owner.user.id)).toEqual({ ...before, sessions: [] });
    expect(await userRow(owner.user.id)).toEqual({ ...identity, password_hash: resetHash });
    expect(await (await env.ATTACHMENTS.get(key))!.text()).toBe("private bytes");
    expect((await api("/api/auth/me", { cookie: owner.cookie })).status).toBe(401);
    expect((await login(owner.user.username, "operator-reset-password")).user).toEqual(owner.user);
  });
});
