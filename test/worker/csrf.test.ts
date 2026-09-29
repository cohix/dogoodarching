import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sameOriginGuard, validateJson } from "../../src/lib/http";
import type { AppBindings } from "../../src/lib/rbac";
import { api, bootstrapCoach, bootstrapTeam, DEFAULT_PASSWORD, type RequestOptions } from "./helpers";

const credentials = { username: "csrf-owner", password: DEFAULT_PASSWORD };

describe("unsafe API requests require same-origin proof for every body type", () => {
  const requests: [string, RequestOptions][] = [
    ["/api/auth/bootstrap", { json: credentials }],
    ["/api/plan/sessions/files", { body: new Uint8Array([1, 2]), headers: { "content-type": "application/pdf" } }],
    ["/api/auth/logout", { method: "POST" }],
    ["/api/auth/invites/unused", { method: "DELETE" }],
    ["/api/unknown", { method: "PATCH" }],
    ["/api/unknown", { method: "PUT" }],
    // Team meal writes (0003 §3).
    ["/api/coach/meals", { json: { name: "n", summary: "s", ingredients: "i", instructions: "m" } }],
    ["/api/coach/meals/1", { method: "PUT", json: { name: "n", summary: "s", ingredients: "i", instructions: "m" } }],
    ["/api/coach/meals/1", { method: "DELETE" }],
  ];

  it.each(["https://attacker.test", "http://sibling.example.com", "null", "http://example.com:8080", "https://example.com"])("rejects Origin %j even with same-origin Fetch Metadata", async (origin) => {
    for (const [path, options] of requests) {
      const response = await api(path, { ...options, origin, headers: { ...options.headers, "sec-fetch-site": "same-origin" } });
      expect(response.status, `${options.method ?? "POST"} ${path}`).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "Same-origin request required" });
    }
  });

  it.each([undefined, "same-site", "cross-site", "none"])("rejects missing Origin with Fetch Metadata %j", async (site) => {
    for (const [path, options] of requests) {
      const response = await api(path, { ...options, origin: null, headers: { ...options.headers, ...(site ? { "sec-fetch-site": site } : {}) } });
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "Same-origin request required" });
    }
  });

  it.each([false, true])("accepts same-origin proof, including bodyless logout (metadata=%s)", async (metadata) => {
    const proof = metadata ? { origin: null, headers: { "sec-fetch-site": "same-origin" } } : {};
    const response = await api("/api/auth/bootstrap", { json: credentials, ...proof });
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect((await api("/api/auth/logout", { method: "POST", cookie, ...proof })).status).toBe(200);
  });

  it("accepts raw bodies and every unsafe method before route-specific validation", async () => {
    const app = new Hono().use("*", sameOriginGuard).all("*", c => c.text("passed"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const proofs: Record<string, string>[] = [{ origin: "http://example.com" }, { "sec-fetch-site": "same-origin" }];
      for (const headers of proofs) {
        expect((await app.request("http://example.com/api/raw", { method, headers, body: new Uint8Array([1]) })).status).toBe(200);
      }
    }
  });

  it.each(["GET", "HEAD", "OPTIONS"])("exempts %s even with an untrusted Origin", async (method) => {
    const response = await api("/api/auth/status", { method, origin: "null" });
    // The router has no OPTIONS handler; auth still applies after this guard.
    expect(response.status).toBe(method === "OPTIONS" ? 401 : 200);
  });

  it("derives expected origin from the request URL, without trusting forwarded headers", async () => {
    const app = new Hono().use("*", sameOriginGuard).post("*", c => c.text("passed"));
    const response = await app.request("https://actual.example:8443/api/raw", {
      method: "POST", headers: { origin: "https://forged.example", "x-forwarded-host": "forged.example", "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(403);
    expect((await app.request("https://actual.example:8443/api/raw", { method: "POST", headers: { origin: "https://actual.example:8443" } })).status).toBe(200);
  });

  it("rejects a present but empty Origin (before transport can omit empty headers)", async () => {
    const app = new Hono().use("*", sameOriginGuard).post("*", c => c.text("passed"));
    const response = await app.request("http://example.com/api/raw", {
      method: "POST", headers: { origin: "", "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(403);
  });
});

describe("JSON content type validation", () => {
  it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "application/problem+json"])("rejects %j before trying to parse invalid JSON", async (contentType) => {
    // Bytes prevent fetch from implicitly adding text/plain for a string body.
    const response = await api("/api/auth/bootstrap", {
      body: new TextEncoder().encode("not JSON"), headers: contentType ? { "content-type": contentType } : {},
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  it("does not read a non-JSON body", async () => {
    const app = new Hono<AppBindings>();
    const parse = vi.fn();
    app.use("*", async (c, next) => { c.req.json = parse; await next(); });
    app.post("*", validateJson(z.object({})), c => c.json({ ok: true }));
    expect((await app.request("/", { method: "POST", body: "invalid" })).status).toBe(415);
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps malformed JSON at 400", async () => {
    const response = await api("/api/auth/bootstrap", { body: "{", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  it.each(["application/json; charset=utf-8", 'application/json;charset="UTF-8"', "Application/JSON"])("accepts %s", async (contentType) => {
    const response = await api("/api/auth/bootstrap", { body: JSON.stringify(credentials), headers: { "content-type": contentType } });
    expect(response.status).toBe(201);
  });

  it("bodyless DELETE stays usable without Content-Type", async () => {
    const { cookie } = await bootstrapCoach();
    const response = await api("/api/auth/invites/unknown", { method: "DELETE", cookie });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Invite not found" });
  });
});

it("missing Origin with same-origin metadata reaches an authenticated raw upload and bodyless DELETE", async () => {
  // Personal uploads are athlete-only (0003 §5).
  const { athlete } = await bootstrapTeam();
  const proof = { origin: null, headers: { "sec-fetch-site": "same-origin" }, cookie: athlete.cookie };
  const upload = await api("/api/plan/sessions/files?dayKey=mon&kind=document&label=CSRF", {
    ...proof, method: "POST", headers: { ...proof.headers, "content-type": "application/pdf" },
    body: new File([new Uint8Array([1,2,3])], "csrf.pdf", { type: "application/pdf" }),
  });
  expect(upload.status).toBe(200);
  const { id } = await upload.json() as { id: number };
  expect((await api(`/api/plan/attachments/${id}`, { ...proof, method: "DELETE" })).status).toBe(200);
});
