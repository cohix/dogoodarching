// Scheduled housekeeping (Cron Trigger in wrangler.toml, `scheduled` handler in
// src/index.ts) and the durable R2 cleanup queue shared by account deletion,
// import replacement, attachment deletion and upload recovery.
//
// Invariants:
// - A `blob_cleanup` record is written in the SAME D1 batch that removes the
//   last reference to a blob (`enqueueBlobCleanup*` return batch statements
//   for that purpose). R2 is only ever touched after the batch committed.
// - A record is removed only after `bucket.delete` succeeded. Failures bump
//   `attempts`, store the error and push `next_attempt_at` out (backoff), so the
//   next cron run retries. Nothing is ever given up on.
// - A key that is still referenced by an attachment row is never deleted from
//   R2. Its record is dropped instead: keys are random and never reused, so a
//   live reference means the blob belongs to a row whose own removal path will
//   enqueue the key again.
// - Every step processes bounded batches so a run stays within Worker limits.

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema, type Db, type Env } from "../db";
import { backfillAttachmentSizes } from "./attachments";

/** Rows removed per statement; the loop below repeats up to MAX_ROUNDS times. */
export const CLEANUP_BATCH_SIZE = 500;
const MAX_ROUNDS = 20;
/** Blob records attempted per run. Each needs one R2 call. */
export const BLOB_CLEANUP_BATCH_SIZE = 100;
/** Invites are kept 30 days after use, or 30 days after expiring unused. */
export const INVITE_RETENTION_MS = 30 * 86400 * 1000;
/** Retry backoff: 15 min * attempts, capped at 24 h. */
const BACKOFF_STEP_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 3600 * 1000;
const MAX_BIND_PARAMS = 100;

export type BlobCleanupRow = typeof schema.blobCleanup.$inferSelect;

export interface EnqueueOptions {
  /** Origin label stored on the record (operators only). */
  reason: string;
  /** Do not attempt before this instant (default: immediately). */
  notBefore?: Date;
}

/**
 * Batch statements that record `keys` for deletion. Include them in the same
 * `db.batch([...])` that deletes the attachment rows referencing those keys.
 * Empty keys and duplicates are ignored; an existing record for a key is left
 * untouched (`INSERT OR IGNORE`), so calling this twice is harmless. Chunked
 * to stay under D1's bound-parameter limit.
 */
export function enqueueBlobCleanup(db: Db, keys: readonly string[], options: EnqueueOptions) {
  const unique = [...new Set(keys.filter((key) => key !== ""))];
  const nextAttemptAt = options.notBefore ?? new Date();
  const createdAt = new Date();
  const perRow = 6;
  const chunkSize = Math.floor(MAX_BIND_PARAMS / perRow);
  const statements = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const rows = unique.slice(i, i + chunkSize).map((blobKey) => ({
      blobKey, reason: options.reason, attempts: 0, lastError: null, nextAttemptAt, createdAt,
    }));
    // Query builders only: drizzle's D1 batch cannot bind parameters of raw
    // `db.run` statements.
    statements.push(db.insert(schema.blobCleanup).values(rows).onConflictDoNothing());
  }
  return statements;
}

export type BlobCleanupStatement = ReturnType<typeof enqueueBlobCleanup>[number];

/**
 * One batch statement that records every non-empty `blob_key` of the
 * attachment rows matching `where` (a condition over
 * `planned_session_attachments`, plus any extra guard the caller wants
 * evaluated inside the transaction). Use it when the keys are selected by the
 * batch itself rather than pre-read, e.g. account deletion, so a concurrent
 * upload committed just before the batch is still captured. Place it BEFORE
 * the statement that deletes those rows.
 */
export function enqueueBlobCleanupFromAttachments(db: Db, where: SQL, options: EnqueueOptions) {
  const nextAttemptAt = (options.notBefore ?? new Date()).getTime();
  const createdAt = Date.now();
  // The SELECT always has a WHERE clause, which SQLite requires before an
  // upsert clause on INSERT ... SELECT.
  return db.insert(schema.blobCleanup).select(sql`
    SELECT blob_key, ${options.reason}, 0, NULL, ${nextAttemptAt}, ${createdAt}
    FROM planned_session_attachments
    WHERE blob_key != '' AND (${where})
  `).onConflictDoNothing();
}

export interface BlobCleanupSummary {
  deleted: number;
  failed: number;
  /** Records dropped because an attachment row still references the key. */
  skippedReferenced: number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

/**
 * Attempts the given cleanup records: deletes unreferenced keys from R2 and
 * removes their records; records failures for the next run. Safe to call
 * concurrently with the cron (a second delete of a missing key succeeds).
 */
export async function processBlobCleanup(db: Db, bucket: R2Bucket, rows: readonly BlobCleanupRow[], now = new Date()): Promise<BlobCleanupSummary> {
  const summary: BlobCleanupSummary = { deleted: 0, failed: 0, skippedReferenced: 0 };
  if (rows.length === 0) return summary;
  for (const row of rows) {
    // Fence expired commits in D1 BEFORE checking references/deleting R2.
    // A commit that already won has removed its reservation and made a live
    // attachment; a later commit sees expires_at=0 and cannot insert.
    await db.update(schema.uploadReservations).set({ expiresAt: new Date(0) })
      .where(and(eq(schema.uploadReservations.blobKey, row.blobKey), lte(schema.uploadReservations.expiresAt, now)));
    const [reservation] = await db.select().from(schema.uploadReservations)
      .where(eq(schema.uploadReservations.blobKey, row.blobKey)).limit(1);
    // Active uploads may still commit; expired leases can never commit. Keep
    // abandoned leases as tombstones and retry their keys indefinitely: a put
    // may finish after the first cleanup attempt (even after Worker death).
    // Removing a tombstone on a missing head/delete would lose that late blob.
    if (reservation && reservation.expiresAt > now) continue;
    const [referenced] = await db.select({ id: schema.plannedSessionAttachments.id })
      .from(schema.plannedSessionAttachments)
      .where(eq(schema.plannedSessionAttachments.blobKey, row.blobKey)).limit(1);
    if (referenced) {
      await db.delete(schema.blobCleanup).where(eq(schema.blobCleanup.blobKey, row.blobKey));
      summary.skippedReferenced += 1;
      continue;
    }
    try {
      await bucket.delete(row.blobKey);
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = Math.min(BACKOFF_STEP_MS * attempts, BACKOFF_MAX_MS);
      await db.update(schema.blobCleanup).set({
        attempts,
        lastError: errorText(error),
        nextAttemptAt: new Date(now.getTime() + delay),
      }).where(eq(schema.blobCleanup.blobKey, row.blobKey));
      summary.failed += 1;
      continue;
    }
    // Only after R2 confirmed the delete. Deleting a missing key succeeds, so
    // a record whose blob is already gone is cleared too.
    if (reservation) {
      await db.update(schema.blobCleanup).set({ nextAttemptAt: new Date(now.getTime() + BACKOFF_MAX_MS) })
        .where(eq(schema.blobCleanup.blobKey, row.blobKey));
    } else {
      await db.delete(schema.blobCleanup).where(eq(schema.blobCleanup.blobKey, row.blobKey));
    }
    summary.deleted += 1;
  }
  return summary;
}

/** Prompt attempt for specific keys right after their batch committed (e.g. from `waitUntil`). */
export async function attemptBlobCleanup(db: Db, bucket: R2Bucket, keys: readonly string[]): Promise<BlobCleanupSummary> {
  const wanted = [...new Set(keys.filter((key) => key !== ""))];
  const rows: BlobCleanupRow[] = [];
  for (let i = 0; i < wanted.length; i += MAX_BIND_PARAMS) {
    rows.push(...await db.select().from(schema.blobCleanup).where(inArray(schema.blobCleanup.blobKey, wanted.slice(i, i + MAX_BIND_PARAMS))));
  }
  return processBlobCleanup(db, bucket, rows);
}

/** Due records, oldest first, bounded. */
export async function duePendingBlobs(db: Db, now = new Date(), limit = BLOB_CLEANUP_BATCH_SIZE): Promise<BlobCleanupRow[]> {
  return db.select().from(schema.blobCleanup)
    .where(lte(schema.blobCleanup.nextAttemptAt, now))
    .orderBy(asc(schema.blobCleanup.nextAttemptAt), asc(schema.blobCleanup.blobKey))
    .limit(limit);
}

async function deleteInRounds(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const changed = await run();
    total += changed;
    if (changed < CLEANUP_BATCH_SIZE) break;
  }
  return total;
}

function changes(result: unknown): number {
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

/** Deletes sessions whose `expires_at` is at or before `now`, in bounded rounds. */
export async function deleteExpiredSessions(db: Db, now = new Date()): Promise<number> {
  return deleteInRounds(async () => changes(await db.run(sql`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions WHERE expires_at <= ${now.getTime()} LIMIT ${CLEANUP_BATCH_SIZE}
    )
  `)));
}

/**
 * Deletes invites used at least 30 days ago, or unused ones that expired at
 * least 30 days ago. Unused invites inside the retention window are kept so
 * coaches can still see recent expired links in their list.
 */
export async function deleteStaleInvites(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INVITE_RETENTION_MS);
  const stale = or(
    and(isNotNull(schema.invites.usedAt), lte(schema.invites.usedAt, cutoff)),
    and(isNull(schema.invites.usedAt), lte(schema.invites.expiresAt, cutoff)),
  );
  return deleteInRounds(async () => changes(await db.run(sql`
    DELETE FROM invites WHERE id IN (
      SELECT id FROM invites WHERE ${stale} LIMIT ${CLEANUP_BATCH_SIZE}
    )
  `)));
}

export interface CleanupReport {
  sessionsDeleted: number;
  invitesDeleted: number;
  blobs: BlobCleanupSummary;
  backfill: { updated: number; missing: number; failed: number };
}

/**
 * The cron job body. Tests call it directly with `env` and a fixed `now`;
 * the `scheduled` handler passes the trigger's `scheduledTime`. Every step is
 * idempotent and bounded, so overlapping or repeated runs are safe.
 */
export async function runScheduledCleanup(env: Pick<Env, "DB" | "ATTACHMENTS">, now = new Date()): Promise<CleanupReport> {
  const db = getDb(env.DB);
  const sessionsDeleted = await deleteExpiredSessions(db, now);
  const invitesDeleted = await deleteStaleInvites(db, now);
  const blobs = await processBlobCleanup(db, env.ATTACHMENTS, await duePendingBlobs(db, now), now);
  const backfill = await backfillAttachmentSizes(db, env.ATTACHMENTS, now);
  return { sessionsDeleted, invitesDeleted, blobs, backfill };
}
