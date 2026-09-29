import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Shape of a Workers Rate Limiting binding (`[[ratelimits]]` in
 * wrangler.toml). Structural rather than the global `RateLimit` type so tests
 * can substitute plain objects.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateLimitBindingName = "RATE_LIMIT_5_PER_MIN" | "RATE_LIMIT_10_PER_MIN";

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  /** 5 requests per 60 s window per key. Optional in the type because a missing binding must fail closed at runtime. */
  RATE_LIMIT_5_PER_MIN?: RateLimitBinding;
  /** 10 requests per 60 s window per key. */
  RATE_LIMIT_10_PER_MIN?: RateLimitBinding;
  /**
   * TEST/LOCAL ONLY. When set, `lib/rate-limit.ts` replaces the bindings with
   * a deterministic mock (`allow`, `deny`, `deny:<key prefix>` or `error`).
   * It is never declared in wrangler.toml; vitest.config.ts injects it.
   */
  RATE_LIMIT_MODE?: string;
}

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;

export { schema };
