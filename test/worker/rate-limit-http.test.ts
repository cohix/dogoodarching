import { env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { RateLimitBinding } from "../../src/db";
import { api, bootstrapCoach, bootstrapTeam, createInvite, DEFAULT_PASSWORD, uploadFile } from "./helpers";

const originalFive = env.RATE_LIMIT_5_PER_MIN;
const originalTen = env.RATE_LIMIT_10_PER_MIN;
afterEach(() => {
  env.RATE_LIMIT_MODE = "allow";
  env.RATE_LIMIT_5_PER_MIN = originalFive;
  env.RATE_LIMIT_10_PER_MIN = originalTen;
});

function record() {
  const calls: Array<[number, string]> = [];
  const binding = (n: number): RateLimitBinding => ({ limit: async ({ key }) => { calls.push([n, key]); return { success: true }; } });
  env.RATE_LIMIT_MODE = undefined;
  env.RATE_LIMIT_5_PER_MIN = binding(5);
  env.RATE_LIMIT_10_PER_MIN = binding(10);
  return calls;
}

it("HTTP login checks IP first then the same normalized key for LoGin and login, ignoring forwarded IP", async () => {
  await bootstrapCoach("login");
  const calls = record();
  for (const username of ["LoGin", "login"]) {
    expect((await api("/api/auth/login", { json: { username, password: DEFAULT_PASSWORD }, headers: { "cf-connecting-ip": "192.0.2.4", "x-forwarded-for": "198.51.100.9" } })).status).toBe(200);
  }
  expect(calls).toEqual([[10,"login:192.0.2.4"],[5,"login-user:login"],[10,"login:192.0.2.4"],[5,"login-user:login"]]);
  calls.length = 0;
  expect((await api("/api/auth/login", { body: "bad JSON", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" } })).status).toBe(400);
  expect(calls).toEqual([[10,"login:unknown"]]);
});

it("routes select 5/min for bootstrap and password checks; 10/min for invites and upload actor", async () => {
  const calls = record();
  const owner = await bootstrapCoach();
  const token = await createInvite(owner);
  const accepted = await api("/api/auth/accept-invite", { json: { token, username: "athlete", password: DEFAULT_PASSWORD } });
  expect(accepted.status).toBe(201);
  const athlete = await accepted.json() as { id: string };
  expect((await uploadFile(`/api/coach/athletes/${athlete.id}/plan/sessions/files`, owner)).status).toBe(200);
  expect((await uploadFile("/api/plan/sessions/files", owner)).status).toBe(200);
  expect((await api("/api/auth/password", { cookie: owner.cookie, json: { currentPassword: "incorrect", newPassword: "new-password" } })).status).toBe(400);
  expect((await api("/api/auth/account", { method: "DELETE", cookie: owner.cookie, json: { password: "incorrect" } })).status).toBe(400);
  expect((await api("/api/auth/owner/transfer", { cookie: owner.cookie, json: { coachId: "unknown", password: "incorrect" } })).status).toBe(400);
  expect(calls).toEqual([
    [5,"bootstrap:unknown"], [10,`invite-create:${owner.user.id}`], [10,"accept-invite:unknown"],
    [10,`upload:${owner.user.id}`], [10,`upload:${owner.user.id}`],
    [5,`password-verify:${owner.user.id}`], [5,`password-verify:${owner.user.id}`], [5,`password-verify:${owner.user.id}`],
  ]);
});

it("coach uploads are denied by the actor key, never charged to the athlete key", async () => {
  const { coach, athlete } = await bootstrapTeam();
  env.RATE_LIMIT_MODE = `deny:upload:${coach.user.id}`;
  const denied = await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach);
  expect(denied.status).toBe(429);
  expect(await denied.json()).toEqual({ error: "Too many attempts. Try again later." });
  expect((await env.ATTACHMENTS.list()).objects).toEqual([]);
  env.RATE_LIMIT_MODE = `deny:upload:${athlete.user.id}`;
  expect((await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach)).status).toBe(200);
  expect((await uploadFile("/api/plan/sessions/files", athlete)).status).toBe(429);
});

it.each(["missing", "throws", "denies"])("real binding path %s fails closed through SELF.fetch", async kind => {
  await bootstrapCoach("login");
  env.RATE_LIMIT_MODE = undefined;
  const binding = kind === "missing" ? undefined : { limit: async () => {
    if (kind === "throws") throw new Error("binding failed");
    return { success: false };
  } };
  env.RATE_LIMIT_10_PER_MIN = binding;
  let response = await api("/api/auth/login", { json: { username: "login", password: DEFAULT_PASSWORD } });
  const status = kind === "denies" ? 429 : 503;
  const error = kind === "denies" ? "Too many attempts. Try again later." : "Service temporarily unavailable. Try again later.";
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  env.RATE_LIMIT_10_PER_MIN = { limit: async () => ({ success: true }) };
  env.RATE_LIMIT_5_PER_MIN = binding;
  response = await api("/api/auth/login", { json: { username: "login", password: DEFAULT_PASSWORD } });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});
