import { createExecutionContext, env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { getDb } from "../../src/db";
import { hashPassword } from "../../src/lib/auth";
import { authenticate } from "../../src/services/auth";
import worker from "../../src/index";
import { api, bootstrapTeam, DEFAULT_PASSWORD } from "./helpers";
import { interceptD1, rendezvous } from "./security-auth-fixtures";

it.each(["password change", "operator reset"])("a pending old-password login cannot create a session after %s", async action => {
  const { athlete } = await bootstrapTeam();
  const real = env.DB, paused = rendezvous(), resume = rendezvous(); let gated = false;
  const intercepted = interceptD1(real, async (query, phase) => {
    if (!gated && phase === "before" && /INSERT INTO sessions/i.test(query)) { gated = true; paused.release(); await resume.reached; }
  });
  const login = worker.fetch(new Request("http://example.com/api/auth/login", {
    method: "POST", headers: { origin: "http://example.com", "content-type": "application/json" },
    body: JSON.stringify({ username: athlete.user.username, password: DEFAULT_PASSWORD }),
  }), { ...env, DB: intercepted }, createExecutionContext());
  try {
    await vi.waitFor(() => expect(gated).toBe(true));
    if (action === "password change") {
      expect((await api("/api/auth/password", { cookie: athlete.cookie, json: { currentPassword: DEFAULT_PASSWORD, newPassword: "new-distinct-password" } })).status).toBe(200);
    } else {
      await real.batch([
        real.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword("new-distinct-password"), athlete.user.id),
        real.prepare("DELETE FROM sessions WHERE user_id = ?").bind(athlete.user.id),
      ]);
    }
    resume.release();
    const response = await login;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid username or password" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await real.prepare("SELECT id FROM sessions WHERE user_id = ?").bind(athlete.user.id).all()).results).toHaveLength(action === "password change" ? 1 : 0);
  } finally { resume.release(); await login; }
});

it("normalizes failed password work for unknown, malformed, deactivated, lower and current hashes", async () => {
  const { athlete } = await bootstrapTeam();
  const salt = btoa(String.fromCharCode(...new Uint8Array(16)));
  const hash = btoa(String.fromCharCode(...new Uint8Array(32)));
  const cases = [
    { count: 10000, username: athlete.user.username },
    { count: 100000, username: athlete.user.username },
    { count: 100000, username: "unknown" },
    { count: 10000, username: athlete.user.username, deactivated: true },
    { count: 0, username: athlete.user.username },
  ];
  for (const entry of cases) {
    await env.DB.prepare("UPDATE users SET password_hash = ?, deactivated_at = ? WHERE id = ?")
      .bind(entry.count ? `pbkdf2$${entry.count}$${salt}$${hash}` : "invalid", entry.deactivated ? Date.now() : null, athlete.user.id).run();
    const derivations = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      expect(await authenticate(getDb(env.DB), { username: entry.username, password: "wrong-password" })).toBeNull();
      expect(derivations.mock.calls.reduce((sum, [algorithm]) => sum + (algorithm as { iterations: number }).iterations, 0)).toBe(100000);
    } finally { derivations.mockRestore(); }
  }
});
