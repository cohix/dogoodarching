// Plan attachments: links stored in D1, documents and photos stored in R2 with
// a D1 row pointing at the blob. Functions that touch R2 take the bucket as
// an explicit dependency next to the database.

import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { AuthUser } from "../lib/auth";
import { buildContentDisposition, UserFacingError } from "../lib/http";
import { effectiveFileMimeType, plannedSessionFileInput, type PlannedSessionFileInput, type PlannedSessionLinkInput } from "../lib/validation";
import { attemptBlobCleanup, enqueueBlobCleanup, enqueueBlobCleanupFromAttachments } from "./cleanup";

export type AttachmentRow = typeof schema.plannedSessionAttachments.$inferSelect;

/** Public URL for an attachment: the stored link, or the Worker's download route for files. */
export function attachmentUrl(attachment: Pick<AttachmentRow, "id" | "kind" | "url">): string {
  return attachment.kind === "link" ? attachment.url : `/api/plan/attachments/${attachment.id}/file`;
}

export async function addPlannedSessionLinkFor(db: Db, userId: string, input: PlannedSessionLinkInput) {
  const rows = await db.insert(schema.plannedSessionAttachments).values({
    userId, dayKey: input.dayKey, kind: "link", label: input.label, url: input.url, blobKey: "", mimeType: "text/uri-list", createdAt: new Date(),
  }).returning({ id: schema.plannedSessionAttachments.id });
  const row = rows[0];
  if (!row) throw new Error("Attachment could not be saved");
  return { id: row.id };
}

export const MAX_UPLOAD_BYTES = 8_000_000;
export const MAX_USER_FILES = 100;
export const MAX_USER_FILE_BYTES = 500_000_000;
export const UPLOAD_RESERVATION_MS = 60 * 60 * 1000;

/** Untrusted length metadata, verified against actual streamed bytes. Browser
 * File uploads send X-File-Size; browsers control Content-Length themselves.
 * A missing length in both places is rejected without buffering or reading.
 */
export function uploadSize(request: Request): number {
  const contentLength = request.headers.get("content-length");
  const fileSize = request.headers.get("x-file-size");
  for (const [name, value] of [["Content-Length", contentLength], ["X-File-Size", fileSize]]) {
    if (value !== null && !/^\d+$/.test(value)) throw new UserFacingError(400, `Invalid ${name}`);
    if (value !== null && Number(value) > MAX_UPLOAD_BYTES) throw new UserFacingError(413, "Attachment is larger than 8 MB");
  }
  if (contentLength !== null && fileSize !== null && Number(contentLength) !== Number(fileSize)) {
    throw new UserFacingError(400, "File size does not match Content-Length");
  }
  const length = contentLength ?? fileSize;
  if (length === null) throw new UserFacingError(400, "Content-Length or X-File-Size is required");
  if (!Number(length) || !request.body) throw new UserFacingError(400, "File body is required");
  return Number(length);
}

/** R2 consumes before request EOF. FixedLengthStream supplies its known-length
 * contract; the counting transform enforces both the cap and exact EOF. Both
 * pumps settle before cleanup, and an R2 failure cancels the upstream body.
 */
async function putUpload(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<void> {
  const fixed = new FixedLengthStream(size);
  const reader = body.getReader();
  const writer = fixed.writable.getWriter();
  // Explicitly observe both closure promises, including early R2 failures.
  void reader.closed.catch(() => {});
  void writer.closed.catch(() => {});
  let bodyError: UserFacingError | undefined;
  let storageFailed = false;
  const pump = (async () => {
    let actual = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        actual += value.byteLength;
        if (actual > MAX_UPLOAD_BYTES) throw new UserFacingError(413, "Attachment is larger than 8 MB");
        if (actual > size) throw new UserFacingError(400, "File size does not match Content-Length");
        await writer.write(value); // backpressure: at most the current chunk
      }
      if (actual !== size) throw new UserFacingError(400, "File size does not match Content-Length");
      await writer.close();
    } catch (error) {
      if (!storageFailed) bodyError = error instanceof UserFacingError ? error : new UserFacingError(400, "File upload was interrupted");
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();
  const put = Promise.resolve().then(() => bucket.put(key, fixed.readable, { httpMetadata: { contentType: mimeType } }))
    .catch(async (error: unknown) => {
      storageFailed = true;
      await reader.cancel().catch(() => {});
      if (!fixed.readable.locked) await fixed.readable.cancel().catch(() => {});
      await writer.abort(error).catch(() => {});
      throw error;
    });
  const [pumped, stored] = await Promise.allSettled([pump, put]);
  reader.releaseLock();
  writer.releaseLock();
  if (bodyError) throw bodyError;
  if (stored.status === "rejected") throw stored.reason;
  if (pumped.status === "rejected") throw pumped.reason;
}

/** Thin routes share validation and a secret-free unexpected-error boundary. */
export async function uploadPlannedSessionFileFor(db: Db, bucket: R2Bucket, userId: string, actorId: string, request: Request) {
  try {
    const mimeType = effectiveFileMimeType(request.headers.get("content-type") ?? "");
    if (mimeType === "application/octet-stream") throw new UserFacingError(415, "Unsupported file type");
    const metadata = plannedSessionFileInput.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!metadata.success) throw new UserFacingError(400, "Invalid upload metadata: provide dayKey, kind and label (1-160 characters)");
    const size = uploadSize(request);
    return await addPlannedSessionFileFor(db, bucket, userId, actorId, metadata.data, mimeType, request.body!, size);
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    console.error("Upload failed");
    throw new UserFacingError(500, "Upload failed");
  }
}

/** Admission is one conditional INSERT, counting both committed files and leases.
 * No user FK on recovery rows: deletion during R2 put must not erase recovery.
 */
export async function addPlannedSessionFileFor(
  db: Db, bucket: R2Bucket, userId: string, actorId: string,
  input: PlannedSessionFileInput, mimeType: string, body: ReadableStream<Uint8Array>, size: number,
) {
  const blobKey = `attachments/${userId}/${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + UPLOAD_RESERVATION_MS);
  const actorAvailable = sql`EXISTS (SELECT 1 FROM users WHERE id = ${actorId} AND deactivated_at IS NULL
    AND (id = ${userId} OR (role = 'coach' AND EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND role = 'athlete'))))`;
  const files = sql`SELECT size_bytes FROM planned_session_attachments WHERE user_id = ${userId} AND kind != 'link'
    UNION ALL SELECT size_bytes FROM upload_reservations WHERE user_id = ${userId} AND expires_at > ${Date.now()}`;
  const unknown = sql`EXISTS (SELECT 1 FROM (${files}) WHERE size_bytes IS NULL OR size_bytes < 0)`;
  const count = sql`(SELECT count(*) FROM (${files}))`;
  const total = sql`(SELECT coalesce(sum(size_bytes), 0) FROM (${files}))`;
  const [reserved, accounting] = await db.batch([
    db.insert(schema.uploadReservations).select(sql`
      SELECT ${blobKey}, ${userId}, ${actorId}, ${size}, ${expiresAt.getTime()}
      WHERE ${actorAvailable} AND NOT ${unknown} AND ${count} < ${MAX_USER_FILES}
      AND ${total} + ${size} <= ${MAX_USER_FILE_BYTES}
    `).returning(),
    db.select({ available: sql<number>`${actorAvailable}`, unknown: sql<number>`${unknown}`, count: sql<number>`${count}`, total: sql<number>`${total}` }).from(schema.users).limit(1),
    // Even a crash immediately after admission leaves a durable cleanup record.
    ...enqueueBlobCleanup(db, [blobKey], { reason: "upload", notBefore: expiresAt }),
  ]);
  if (!reserved.length) {
    await db.delete(schema.blobCleanup).where(eq(schema.blobCleanup.blobKey, blobKey));
    const state = accounting[0];
    if (!state?.available) throw new UserFacingError(401, "Upload account is no longer available");
    if (state.unknown) throw new UserFacingError(413, "Upload accounting is incomplete; wait for backfill or delete unavailable files");
    if (state.count >= MAX_USER_FILES) throw new UserFacingError(413, "File limit reached (100 files per user)");
    throw new UserFacingError(413, "Storage limit reached (500 MB per user)");
  }
  try {
    await putUpload(bucket, blobKey, body, size, mimeType);
    const [rows] = await db.batch([
      db.insert(schema.plannedSessionAttachments).select(sql`
        SELECT NULL, user_id, ${input.dayKey}, ${input.kind}, ${input.label}, '', blob_key,
          ${mimeType}, size_bytes, NULL, ${Date.now()}
        FROM upload_reservations WHERE blob_key = ${blobKey} AND expires_at > ${Date.now()}
          AND ${actorAvailable}
      `).returning({ id: schema.plannedSessionAttachments.id }),
      db.delete(schema.blobCleanup).where(and(eq(schema.blobCleanup.blobKey, blobKey),
        sql`EXISTS (SELECT 1 FROM planned_session_attachments WHERE blob_key = ${blobKey})`)),
      db.delete(schema.uploadReservations).where(eq(schema.uploadReservations.blobKey, blobKey)),
    ]);
    if (!rows[0]) throw new UserFacingError(400, "Upload expired or account changed; retry the upload");
    return rows[0];
  } catch (error) {
    // The put has settled. Release quota and make cleanup due; if D1 itself is
    // unavailable, the pre-put record and lease remain for scheduled recovery.
    try {
      await db.batch([
        db.delete(schema.uploadReservations).where(eq(schema.uploadReservations.blobKey, blobKey)),
        db.update(schema.blobCleanup).set({ nextAttemptAt: new Date() }).where(eq(schema.blobCleanup.blobKey, blobKey)),
      ]);
      await attemptBlobCleanup(db, bucket, [blobKey]);
    } catch {
      console.error("Upload cleanup deferred");
    }
    throw error;
  }
}

/** Bounded, resumable backfill. Successful heads fill NULL sizes conditionally;
 * failures/missing blobs stay unknown (and block uploads), retrying oldest first.
 * Missing files can still be deleted through the normal attachment endpoint.
 */
export async function backfillAttachmentSizes(db: Db, bucket: R2Bucket, now = new Date(), limit = 50) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(sql`kind != 'link' AND size_bytes IS NULL`)
    .orderBy(schema.plannedSessionAttachments.sizeCheckedAt, schema.plannedSessionAttachments.id)
    .limit(Math.max(1, Math.min(100, limit)));
  const report = { updated: 0, missing: 0, failed: 0 };
  for (const row of rows) {
    let size: number | null = null;
    try {
      const object = row.blobKey ? await bucket.head(row.blobKey) : null;
      if (object && Number.isSafeInteger(object.size) && object.size >= 0) size = object.size;
      else report.missing++;
    } catch {
      report.failed++;
      console.error("Upload size backfill failed");
    }
    await db.update(schema.plannedSessionAttachments).set({ sizeBytes: size, sizeCheckedAt: now })
      .where(and(eq(schema.plannedSessionAttachments.id, row.id), eq(schema.plannedSessionAttachments.blobKey, row.blobKey), sql`size_bytes IS NULL`));
    if (size !== null) report.updated++;
  }
  return report;
}

/** Deletes the row and its blob (if any). False when the user has no such attachment. */
export async function deletePlannedSessionAttachmentFor(db: Db, bucket: R2Bucket, userId: string, attachmentId: number) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(and(eq(schema.plannedSessionAttachments.id, attachmentId), eq(schema.plannedSessionAttachments.userId, userId))).limit(1);
  const attachment = rows[0];
  if (!attachment) return false;
  await db.batch([
    enqueueBlobCleanupFromAttachments(db, sql`id = ${attachmentId} AND user_id = ${userId}`, { reason: "attachment-delete" }),
    db.delete(schema.plannedSessionAttachments).where(and(eq(schema.plannedSessionAttachments.id, attachmentId), eq(schema.plannedSessionAttachments.userId, userId))),
  ]);
  try { await attemptBlobCleanup(db, bucket, [attachment.blobKey]); }
  catch { console.error("Attachment cleanup deferred"); }
  return true;
}

/**
 * Loads an attachment for file download. Returns null unless the requester
 * owns the attachment or is any coach in this deployment.
 */
export async function getAttachmentForDownload(db: Db, attachmentId: number, requester: AuthUser) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(eq(schema.plannedSessionAttachments.id, attachmentId)).limit(1);
  const attachment = rows[0];
  if (!attachment) return null;
  if (attachment.userId === requester.id) return attachment;
  if (requester.role === "coach") return attachment;
  return null;
}

/**
 * Fetches the file bytes for a download, applying the access rule above.
 * Null when the attachment is missing, not a file, or has no blob.
 */
export async function openAttachmentFileFor(db: Db, bucket: R2Bucket, attachmentId: number, requester: AuthUser) {
  const attachment = await getAttachmentForDownload(db, attachmentId, requester);
  if (!attachment || attachment.kind === "link" || !attachment.blobKey) return null;
  const object = await bucket.get(attachment.blobKey);
  if (!object) return null;
  return { attachment, object };
}

/** Response headers for an attachment download. */
export function fileDownloadHeaders(attachment: Pick<AttachmentRow, "label" | "mimeType">, object: R2ObjectBody): Record<string, string> {
  const mimeType = effectiveFileMimeType(attachment.mimeType);
  return {
    "Content-Type": mimeType,
    "Content-Length": String(object.size),
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": buildContentDisposition(attachment.label, mimeType),
    "X-Content-Type-Options": "nosniff",
  };
}
