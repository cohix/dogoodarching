import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb, type Db } from "../db";
import type { AppBindings } from "./rbac";

/** Best-effort client IP for rate-limit keys (Cloudflare-aware). */
export function clientIp(c: Context<AppBindings>): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Fixed-window rate limiter backed by D1. Returns true when the attempt is
 * allowed (and records it), false when the caller has exceeded maxAttempts
 * within windowMs. Each key resets only when its own window expires.
 */
export async function checkRateLimit(
  db: Db,
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  // The conditional upsert admits at most maxAttempts callers, including on
  // the first request and at window rollover. A blocked attempt returns no row.
  const rows = await db.all(sql`
    INSERT INTO rate_limits (key, attempts, window_start) VALUES (${key}, 1, ${now})
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN window_start <= ${now - windowMs} THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ${now - windowMs} THEN ${now} ELSE window_start END
    WHERE window_start <= ${now - windowMs} OR attempts < ${maxAttempts}
    RETURNING attempts
  `);
  return rows.length === 1;
}

/**
 * Middleware: counts the request against `keyFor(c)` and answers 429 once the
 * window's attempts are used up. Place it before body validation so invalid
 * requests still count as attempts.
 */
export function rateLimit(
  keyFor: (c: Context<AppBindings>) => string,
  maxAttempts: number,
  windowMs: number,
) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const allowed = await checkRateLimit(getDb(c.env.DB), keyFor(c), maxAttempts, windowMs);
    if (!allowed) return c.json({ error: "Too many attempts. Try again later." }, 429);
    await next();
  });
}
