// Plan attachments: links stored in D1, documents and photos stored in R2 with
// a D1 row pointing at the blob. Functions that touch R2 take the bucket as
// an explicit dependency next to the database.

import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { AuthUser } from "../lib/auth";
import { buildContentDisposition } from "../lib/http";
import type { PlannedSessionFileInput, PlannedSessionLinkInput } from "../lib/validation";

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

function safeFilename(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return base || "file";
}

export async function addPlannedSessionFileFor(
  db: Db, bucket: R2Bucket, userId: string, input: PlannedSessionFileInput,
) {
  const binary = atob(input.dataBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > 8_000_000) throw new Error("Attachment is larger than 8 MB");
  const blobKey = `attachments/${userId}/${crypto.randomUUID()}-${safeFilename(input.label)}`;
  await bucket.put(blobKey, bytes, { httpMetadata: { contentType: input.mimeType } });
  try {
    const rows = await db.insert(schema.plannedSessionAttachments).values({
      userId, dayKey: input.dayKey, kind: input.kind, label: input.label, url: "", blobKey, mimeType: input.mimeType, createdAt: new Date(),
    }).returning({ id: schema.plannedSessionAttachments.id });
    const row = rows[0];
    if (!row) throw new Error("Attachment could not be saved");
    return { id: row.id };
  } catch (error) {
    await bucket.delete(blobKey);
    throw error;
  }
}

/** Deletes the row and its blob (if any). False when the user has no such attachment. */
export async function deletePlannedSessionAttachmentFor(db: Db, bucket: R2Bucket, userId: string, attachmentId: number) {
  const rows = await db.select().from(schema.plannedSessionAttachments)
    .where(and(eq(schema.plannedSessionAttachments.id, attachmentId), eq(schema.plannedSessionAttachments.userId, userId))).limit(1);
  const attachment = rows[0];
  if (!attachment) return false;
  if (attachment.blobKey) await bucket.delete(attachment.blobKey);
  await db.delete(schema.plannedSessionAttachments).where(eq(schema.plannedSessionAttachments.id, attachmentId));
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
  return {
    "Content-Type": attachment.mimeType || "application/octet-stream",
    "Content-Length": String(object.size),
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": buildContentDisposition(attachment.label, attachment.mimeType || "application/octet-stream"),
    "X-Content-Type-Options": "nosniff",
  };
}
