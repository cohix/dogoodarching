import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { getDb, schema, type Db } from "../db";
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
 * within windowMs. Stale buckets are cleaned up opportunistically.
 */
export async function checkRateLimit(
  db: Db,
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, now - windowMs));
  const rows = await db.select().from(schema.rateLimits).where(eq(schema.rateLimits.key, key)).limit(1);
  const row = rows[0];
  if (!row) {
    await db.insert(schema.rateLimits).values({ key, attempts: 1, windowStart: now });
    return true;
  }
  if (row.attempts >= maxAttempts) return false;
  await db.update(schema.rateLimits).set({ attempts: row.attempts + 1 }).where(eq(schema.rateLimits.key, key));
  return true;
}

/** Convenience wrapper: rate-limit the current request or return a 429 response. */
export async function rateLimitOr429(
  c: Context<AppBindings>,
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<Response | null> {
  const allowed = await checkRateLimit(getDb(c.env.DB), key, maxAttempts, windowMs);
  if (!allowed) return c.json({ error: "Too many attempts. Try again later." }, 429);
  return null;
}
