// Scheduled cleanup (0002 §7): expired sessions, stale invites and the durable
// R2 cleanup queue. `runScheduledCleanup` is called directly with `env` and a
// fixed `now`; the last test drives the Worker's real `scheduled` handler.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../src/db";
import worker from "../../src/index";
import {
  BLOB_CLEANUP_BATCH_SIZE, INVITE_RETENTION_MS, attemptBlobCleanup, duePendingBlobs, enqueueBlobCleanup, processBlobCleanup, runScheduledCleanup,
  type BlobCleanupStatement, type EnqueueOptions,
} from "../../src/services/cleanup";
import { countRows } from "./auth-fixtures";

const DAY = 86400000;
type BatchArg = [BlobCleanupStatement, ...BlobCleanupStatement[]];

const NOW = new Date("2026-09-28T12:00:00Z");

/**
 * Queues keys in their own batch (callers normally add the statements to a
 * larger batch). Due at the fixed test instant unless `notBefore` says otherwise.
 */
async function enqueue(keys: string[], options: EnqueueOptions): Promise<void> {
  const db = getDb(env.DB);
  await db.batch(enqueueBlobCleanup(db, keys, { notBefore: NOW, ...options }) as BatchArg);
}

async function seedUser(id: string): Promise<void> {
  await env.DB.prepare("INSERT INTO users (id, username, password_hash, role, is_owner, created_at) VALUES (?, ?, 'x', 'athlete', 0, ?)")
    .bind(id, id, NOW.getTime()).run();
}

function session(id: string, userId: string, expiresAt: number) {
  return env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, `hash-${id}`, userId, expiresAt, NOW.getTime() - DAY);
}

function invite(id: string, expiresAt: number, usedAt: number | null) {
  return env.DB.prepare("INSERT INTO invites (id, token_hash, created_by, role, expires_at, used_at, created_at) VALUES (?, ?, NULL, 'athlete', ?, ?, ?)")
    .bind(id, `hash-${id}`, expiresAt, usedAt, NOW.getTime() - 60 * DAY);
}

async function ids(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT id FROM "${table}" ORDER BY id`).all<{ id: string }>();
  return results.map((row) => row.id);
}

type CleanupRow = { blob_key: string; reason: string; attempts: number; last_error: string | null; next_attempt_at: number };

async function cleanupRows(): Promise<CleanupRow[]> {
  const { results } = await env.DB.prepare("SELECT blob_key, reason, attempts, last_error, next_attempt_at FROM blob_cleanup ORDER BY blob_key").all<CleanupRow>();
  return results;
}

async function attachmentRow(userId: string, blobKey: string): Promise<void> {
  await env.DB.prepare("INSERT INTO planned_session_attachments (user_id, day_key, kind, label, url, blob_key, mime_type, created_at) VALUES (?, 'mon', 'document', 'f', '', ?, 'application/pdf', ?)")
    .bind(userId, blobKey, NOW.getTime()).run();
}

describe("sessions and invites", () => {
  it("deletes sessions expired at or before now and keeps the rest", async () => {
    await seedUser("u1");
    await env.DB.batch([
      session("s-past", "u1", NOW.getTime() - 1),
      session("s-boundary", "u1", NOW.getTime()),
      session("s-future", "u1", NOW.getTime() + 1),
      session("s-far", "u1", NOW.getTime() + 30 * DAY),
    ]);
    const report = await runScheduledCleanup(env, NOW);
    expect(report.sessionsDeleted).toBe(2);
    expect(await ids("sessions")).toEqual(["s-far", "s-future"]);
    // Repeatable: nothing left to do.
    expect((await runScheduledCleanup(env, NOW)).sessionsDeleted).toBe(0);
  });

  it("deletes invites used 30+ days ago or expired unused 30+ days ago, keeps everything younger", async () => {
    const cutoff = NOW.getTime() - INVITE_RETENTION_MS;
    await env.DB.batch([
      invite("used-old", NOW.getTime() - 40 * DAY, cutoff - 1),
      invite("used-boundary", NOW.getTime() - 40 * DAY, cutoff),
      invite("used-recent", NOW.getTime() - 40 * DAY, cutoff + 1),
      invite("used-yesterday", NOW.getTime() + DAY, NOW.getTime() - DAY),
      invite("unused-expired-old", cutoff - 1, null),
      invite("unused-expired-boundary", cutoff, null),
      invite("unused-expired-recent", cutoff + 1, null),
      invite("unused-expired-yesterday", NOW.getTime() - DAY, null),
      invite("unused-live", NOW.getTime() + DAY, null),
    ]);
    const report = await runScheduledCleanup(env, NOW);
    expect(report.invitesDeleted).toBe(4);
    expect(await ids("invites")).toEqual(["unused-expired-recent", "unused-expired-yesterday", "unused-live", "used-recent", "used-yesterday"]);
    expect((await runScheduledCleanup(env, NOW)).invitesDeleted).toBe(0);
    // Just past 30 days later the "recent" and "yesterday" ones age out too; the live invite stays.
    expect((await runScheduledCleanup(env, new Date(NOW.getTime() + 30 * DAY + 1))).invitesDeleted).toBe(4);
    expect(await ids("invites")).toEqual(["unused-live"]);
  });

  it("removes more than one batch of expired rows in a single run", async () => {
    await seedUser("u1");
    const statements = [];
    for (let i = 0; i < 1200; i++) statements.push(session(`s-${String(i).padStart(4, "0")}`, "u1", NOW.getTime() - 1));
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
    expect((await runScheduledCleanup(env, NOW)).sessionsDeleted).toBe(1200);
    expect(await countRows("sessions")).toBe(0);
  });
});

describe("blob cleanup queue", () => {
  it("enqueueBlobCleanup statements run inside the caller's batch, dedupe keys and ignore existing records", async () => {
    const db = getDb(env.DB);
    await seedUser("u1");
    await attachmentRow("u1", "k1");
    // The caller's batch: queue the keys, then drop the rows that referenced them.
    await db.batch([
      ...enqueueBlobCleanup(db, ["k1", "", "k2", "k1"], { reason: "import" }),
      db.delete(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.userId, "u1")),
    ] as unknown as BatchArg);
    expect(await countRows("planned_session_attachments")).toBe(0);
    expect((await cleanupRows()).map((row) => [row.blob_key, row.reason, row.attempts])).toEqual([["k1", "import", 0], ["k2", "import", 0]]);
    // Second enqueue of k1 keeps the existing record (attempts/reason untouched).
    await env.DB.prepare("UPDATE blob_cleanup SET attempts = 3 WHERE blob_key = 'k1'").run();
    await enqueue(["k1", "k3"], { reason: "attachment-delete" });
    expect((await cleanupRows()).map((row) => [row.blob_key, row.reason, row.attempts])).toEqual([["k1", "import", 3], ["k2", "import", 0], ["k3", "attachment-delete", 0]]);
    // An empty key list produces no statements.
    expect(enqueueBlobCleanup(db, ["", ""], { reason: "x" })).toEqual([]);
    // Large key lists are chunked under D1's parameter limit.
    const many = Array.from({ length: 50 }, (_, i) => `many-${i}`);
    expect(enqueueBlobCleanup(db, many, { reason: "x" }).length).toBeGreaterThan(1);
    await enqueue(many, { reason: "x" });
    expect(await countRows("blob_cleanup")).toBe(53);
  });

  it("deletes unreferenced blobs, removes their records, and never deletes a referenced key", async () => {
    await seedUser("u1");
    await env.ATTACHMENTS.put("orphan", "bytes");
    await env.ATTACHMENTS.put("live", "bytes");
    await attachmentRow("u1", "live");
    await enqueue(["orphan", "live", "already-gone"], { reason: "test" });

    const report = await runScheduledCleanup(env, NOW);
    expect(report.blobs).toEqual({ deleted: 2, failed: 0, skippedReferenced: 1 });
    expect(await env.ATTACHMENTS.head("orphan")).toBeNull();
    expect(await env.ATTACHMENTS.head("live")).not.toBeNull();
    // The referenced key's record is dropped (its row's own deletion re-enqueues it); the others succeeded.
    expect(await cleanupRows()).toEqual([]);
    expect((await runScheduledCleanup(env, NOW)).blobs).toEqual({ deleted: 0, failed: 0, skippedReferenced: 0 });
  });

  it("keeps a record after an R2 failure, backs off, and succeeds on a later run", async () => {
    const db = getDb(env.DB);
    await env.ATTACHMENTS.put("flaky", "bytes");
    await enqueue(["flaky"], { reason: "account-delete" });
    const failing = { delete: async () => { throw new Error("R2 unavailable"); } } as unknown as R2Bucket;

    const first = await processBlobCleanup(db, failing, await duePendingBlobs(db, NOW), NOW);
    expect(first).toEqual({ deleted: 0, failed: 1, skippedReferenced: 0 });
    let [row] = await cleanupRows();
    expect(row).toMatchObject({ blob_key: "flaky", attempts: 1, last_error: "R2 unavailable" });
    expect(row!.next_attempt_at).toBe(NOW.getTime() + 15 * 60 * 1000);
    expect(await env.ATTACHMENTS.head("flaky")).not.toBeNull();

    // Not due yet at NOW: the real bucket is not even asked.
    expect(await duePendingBlobs(db, NOW)).toEqual([]);
    expect((await runScheduledCleanup(env, NOW)).blobs).toEqual({ deleted: 0, failed: 0, skippedReferenced: 0 });
    expect(await env.ATTACHMENTS.head("flaky")).not.toBeNull();

    // Second failure backs off further (15 min * attempts).
    const later = new Date(NOW.getTime() + 20 * 60 * 1000);
    await processBlobCleanup(db, failing, await duePendingBlobs(db, later), later);
    [row] = await cleanupRows();
    expect(row).toMatchObject({ attempts: 2 });
    expect(row!.next_attempt_at).toBe(later.getTime() + 30 * 60 * 1000);

    // Once due again, the scheduled run deletes the blob and only then the record.
    const due = new Date(later.getTime() + 31 * 60 * 1000);
    expect((await runScheduledCleanup(env, due)).blobs).toEqual({ deleted: 1, failed: 0, skippedReferenced: 0 });
    expect(await env.ATTACHMENTS.head("flaky")).toBeNull();
    expect(await cleanupRows()).toEqual([]);
  });

  it("honours notBefore and processes at most one bounded batch per run", async () => {
    const keys = Array.from({ length: BLOB_CLEANUP_BATCH_SIZE + 25 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`);
    await enqueue(keys, { reason: "import" });
    await enqueue(["deferred"], { reason: "upload-reservation", notBefore: new Date(NOW.getTime() + DAY) });
    expect(await countRows("blob_cleanup")).toBe(BLOB_CLEANUP_BATCH_SIZE + 26);

    expect((await runScheduledCleanup(env, NOW)).blobs.deleted).toBe(BLOB_CLEANUP_BATCH_SIZE);
    expect(await countRows("blob_cleanup")).toBe(26);
    expect((await runScheduledCleanup(env, NOW)).blobs.deleted).toBe(25);
    expect((await cleanupRows()).map((row) => row.blob_key)).toEqual(["deferred"]);
    expect((await runScheduledCleanup(env, new Date(NOW.getTime() + DAY))).blobs.deleted).toBe(1);
    expect(await countRows("blob_cleanup")).toBe(0);
  });

  it("attemptBlobCleanup handles only the given keys and leaves referenced ones alone", async () => {
    const db = getDb(env.DB);
    await seedUser("u1");
    await env.ATTACHMENTS.put("mine", "bytes");
    await env.ATTACHMENTS.put("other", "bytes");
    await env.ATTACHMENTS.put("live", "bytes");
    await attachmentRow("u1", "live");
    await enqueue(["mine", "other", "live"], { reason: "test" });
    expect(await attemptBlobCleanup(db, env.ATTACHMENTS, ["mine", "live", "not-queued"])).toEqual({ deleted: 1, failed: 0, skippedReferenced: 1 });
    expect(await env.ATTACHMENTS.head("mine")).toBeNull();
    expect(await env.ATTACHMENTS.head("other")).not.toBeNull();
    expect(await env.ATTACHMENTS.head("live")).not.toBeNull();
    expect((await cleanupRows()).map((row) => row.blob_key)).toEqual(["other"]);
  });
});

describe("scheduled handler", () => {
  it("the Worker's scheduled export runs the job with the trigger time", async () => {
    await seedUser("scheduled-user");
    await env.DB.batch([
      session("expired", "scheduled-user", NOW.getTime()),
      session("valid", "scheduled-user", NOW.getTime() + 1),
    ]);
    await env.ATTACHMENTS.put("queued", "bytes");
    await enqueue(["queued"], { reason: "test" });

    const controller = createScheduledController({ scheduledTime: NOW, cron: "*/15 * * * *" });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await ids("sessions")).toEqual(["valid"]);
    expect(await env.ATTACHMENTS.head("queued")).toBeNull();
    expect(await countRows("blob_cleanup")).toBe(0);
  });
});
