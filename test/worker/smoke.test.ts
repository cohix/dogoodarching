import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, apiJson } from "./helpers";

describe("worker harness", () => {
  it("GET /api/auth/status returns 200 with setupRequired on an empty database", async () => {
    const { status, body } = await apiJson<{ setupRequired: boolean }>("/api/auth/status");
    expect(status).toBe(200);
    expect(body).toEqual({ setupRequired: true });
  });

  it("applies the D1 migrations before the tests run", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    const tables = results.map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["users", "sessions", "invites", "training_sessions", "program_state"]));
    // The pool-workers helper records applied migrations in this table.
    const applied = await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first<{ n: number }>();
    expect(applied?.n).toBeGreaterThanOrEqual(1);
  });

  it("has the R2 ATTACHMENTS binding bound", async () => {
    await env.ATTACHMENTS.put("smoke/hello.txt", "hi");
    const object = await env.ATTACHMENTS.get("smoke/hello.txt");
    expect(await object?.text()).toBe("hi");
    // Unauthenticated API requests are rejected, proving the Worker (not the SPA fallback) answered.
    const response = await api("/api/tracker");
    expect(response.status).toBe(401);
  });
});
