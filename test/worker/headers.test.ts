import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { UserFacingError } from "../../src/lib/http";
import { api, BASE_URL, bootstrapCoach } from "./helpers";

const csp = "default-src 'self'; img-src 'self' blob: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function expectHeaders(response: Response) {
  expect(response.headers.get("content-security-policy")).toBe(csp);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
}

// Inject a failure into a real route, without adding a production test endpoint.
function failingDb(error: Error): D1Database {
  return new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return () => { throw error; };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("API security headers and public errors", () => {
  it.each([["/api/auth/status", 200], ["/api/missing", 404], ["/api/auth/me", 401]] as const)("decorates %s (%s)", async (path, status) => {
    const cookie = status === 404 ? (await bootstrapCoach()).cookie : undefined;
    const response = await api(path, { cookie });
    expect(response.status).toBe(status);
    expectHeaders(response);
  });

  it("decorates early CSRF errors", async () => {
    const response = await api("/api/auth/logout", { method: "POST", origin: null });
    expect(response.status).toBe(403);
    expectHeaders(response);
  });

  it("decorates onError 500 and logs no upstream secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request(`${BASE_URL}/api/auth/status`), {
        ...env, DB: failingDb(new Error("password=secret raw-token request-body")),
      });
      expect(response.status).toBe(500);
      expectHeaders(response);
      expect(await response.json()).toEqual({ error: "Internal server error" });
      expect(log).toHaveBeenCalledExactlyOnceWith("Unhandled API error");
    } finally { log.mockRestore(); }
  });

  it("decorates an unexpected 500 through SELF.fetch", async () => {
    const db = env.DB;
    env.DB = failingDb(new Error("forced database failure"));
    try {
      const response = await api("/api/auth/status");
      expect(response.status).toBe(500);
      expectHeaders(response);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "Internal server error" });
    } finally { env.DB = db; }
  });

  it.each([400, 413, 415] as const)("maps UserFacingError to a public %s", async (status) => {
    const response = await worker.fetch(new Request(`${BASE_URL}/api/auth/status`), {
      ...env, DB: failingDb(new UserFacingError(status, "Public validation message")),
    });
    expect(response.status).toBe(status);
    expectHeaders(response);
    expect(await response.json()).toEqual({ error: "Public validation message" });
  });

  it("decorates a streamed file download without changing bytes or disposition", async () => {
    const { cookie, user } = await bootstrapCoach();
    const blobKey = `attachments/${user.id}/headers.pdf`;
    await env.ATTACHMENTS.put(blobKey, "download bytes", { httpMetadata: { contentType: "application/pdf" } });
    const row = await env.DB.prepare(`INSERT INTO planned_session_attachments
      (user_id, day_key, kind, label, url, blob_key, mime_type, created_at)
      VALUES (?, 'mon', 'document', 'headers', '', ?, 'application/pdf', ?) RETURNING id`)
      .bind(user.id, blobKey, Date.now()).first<{ id: number }>();
    const response = await api(`/api/plan/attachments/${row!.id}/file`, { cookie });
    expect(response.status).toBe(200);
    expectHeaders(response);
    expect(response.headers.get("content-disposition")).toContain('filename="headers.pdf"');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("download bytes");
  });
});
