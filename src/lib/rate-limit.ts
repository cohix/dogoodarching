// Rate limiting on top of Workers Rate Limiting bindings (`[[ratelimits]]` in
// wrangler.toml). Routes never touch a binding: they mount `rateLimit(...)`
// as middleware, after validation when its key needs validated input.
//
// Limits are fixed per binding, so each operation maps to the binding with
// its allowance and a key prefix. Counters are approximate and per Cloudflare
// location (see aspec/architecture/security.md).
//
// FAIL CLOSED: a missing binding or a binding error answers a generic 503
// `{ error }`; limiting is never silently disabled. The only exception is the
// explicit mock selected by the test-only `RATE_LIMIT_MODE` binding, which
// vitest.config.ts injects and wrangler.toml never declares.

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env, RateLimitBinding, RateLimitBindingName } from "../db";
import type { AppBindings } from "./rbac";

export type RateLimitOperation =
  | "login-ip"
  | "login-user"
  | "accept-invite"
  | "bootstrap"
  | "invite-create"
  | "upload"
  | "password-verify"
  | "team-meal-write";

export interface RateLimitRule {
  binding: RateLimitBindingName;
  /** Key prefix; the stored key is `<prefix>:<subject>`. */
  prefix: string;
  /** Allowance per 60 s window, for documentation and tests (the binding enforces it). */
  perMinute: 5 | 10;
}

/** Operation -> binding + key prefix. Add new operations here, never in routes. */
export const RATE_LIMIT_RULES: Readonly<Record<RateLimitOperation, RateLimitRule>> = {
  "login-ip": { binding: "RATE_LIMIT_10_PER_MIN", prefix: "login", perMinute: 10 },
  "login-user": { binding: "RATE_LIMIT_5_PER_MIN", prefix: "login-user", perMinute: 5 },
  "accept-invite": { binding: "RATE_LIMIT_10_PER_MIN", prefix: "accept-invite", perMinute: 10 },
  bootstrap: { binding: "RATE_LIMIT_5_PER_MIN", prefix: "bootstrap", perMinute: 5 },
  "invite-create": { binding: "RATE_LIMIT_10_PER_MIN", prefix: "invite-create", perMinute: 10 },
  upload: { binding: "RATE_LIMIT_10_PER_MIN", prefix: "upload", perMinute: 10 },
  "password-verify": { binding: "RATE_LIMIT_5_PER_MIN", prefix: "password-verify", perMinute: 5 },
  "team-meal-write": { binding: "RATE_LIMIT_10_PER_MIN", prefix: "team-meal", perMinute: 10 },
};

export type RateLimitDecision = "allowed" | "denied" | "unavailable";

export const RATE_LIMITED_MESSAGE = "Too many attempts. Try again later.";
export const RATE_LIMIT_UNAVAILABLE_MESSAGE = "Service temporarily unavailable. Try again later.";

/** Client IP for per-IP keys: Cloudflare's `CF-Connecting-IP` only, never client-supplied headers. */
export function clientIp(c: Context<AppBindings>): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  return "unknown";
}

/** Subject for per-acting-user keys (uploads, invite creation, team meal writes, password verification). */
export function actingUserId(c: Context<AppBindings>): string {
  return c.get("user").id;
}

/** Per-username login keys are case-insensitive, matching the username lookup. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function rateLimitKey(operation: RateLimitOperation, subject: string): string {
  return `${RATE_LIMIT_RULES[operation].prefix}:${subject}`;
}

function mockLimiter(mode: string): RateLimitBinding | undefined {
  if (mode === "allow") return { limit: async () => ({ success: true }) };
  if (mode === "deny") return { limit: async () => ({ success: false }) };
  if (mode.startsWith("deny:")) {
    const prefix = mode.slice("deny:".length);
    return { limit: async ({ key }) => ({ success: !key.startsWith(prefix) }) };
  }
  if (mode === "error") return { limit: async () => { throw new Error("mock rate limit binding error"); } };
  return undefined; // unknown mode: fail closed like a missing binding
}

/**
 * The binding for an operation, or the test/local mock when `RATE_LIMIT_MODE`
 * is set. `undefined` means "unavailable" and callers must fail closed.
 */
export function resolveRateLimiter(env: Env, operation: RateLimitOperation): RateLimitBinding | undefined {
  if (env.RATE_LIMIT_MODE !== undefined) return mockLimiter(env.RATE_LIMIT_MODE);
  return env[RATE_LIMIT_RULES[operation].binding];
}

/**
 * Counts one attempt for `subject` under `operation`. Never throws: binding
 * errors and missing bindings both yield "unavailable" so callers fail closed.
 */
export async function checkRateLimit(env: Env, operation: RateLimitOperation, subject: string): Promise<RateLimitDecision> {
  const limiter = resolveRateLimiter(env, operation);
  if (!limiter) {
    console.error(`rate limit binding ${RATE_LIMIT_RULES[operation].binding} is not configured; failing closed`);
    return "unavailable";
  }
  try {
    const { success } = await limiter.limit({ key: rateLimitKey(operation, subject) });
    return success ? "allowed" : "denied";
  } catch (error) {
    console.error("rate limit binding error; failing closed", error);
    return "unavailable";
  }
}

/**
 * In-handler check for keys known only after validation (e.g. the normalized
 * login username). Returns the `{ error }` response to send (429 or 503) or
 * null when the request may proceed.
 */
async function enforceRateLimit(
  c: Context<AppBindings>,
  operation: RateLimitOperation,
  subject: string,
): Promise<Response | null> {
  const decision = await checkRateLimit(c.env, operation, subject);
  if (decision === "denied") return c.json({ error: RATE_LIMITED_MESSAGE }, 429);
  if (decision === "unavailable") return c.json({ error: RATE_LIMIT_UNAVAILABLE_MESSAGE }, 503);
  return null;
}

/**
 * Middleware: counts the request against `<prefix>:<subjectFor(c)>` and
 * answers 429 once the window's allowance is used up (503 when the binding is
 * unavailable). Mount it before body validation so invalid requests still
 * count as attempts; mount it after `authMiddleware` when the subject is the
 * acting user.
 */
export function rateLimit<I extends import("hono").Input = import("hono").Input>(operation: RateLimitOperation, subjectFor: (c: Context<AppBindings, string, I>) => string) {
  return createMiddleware<AppBindings, string, I>(async (c, next) => {
    const blocked = await enforceRateLimit(c, operation, subjectFor(c));
    if (blocked) return blocked;
    await next();
  });
}
