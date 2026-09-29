/**
 * Work item 0001 section 11 (A10) and section 13: attachment downloads send
 * `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>`
 * with the extension that matches the MIME type. The attachment's owner and
 * any coach can download; another athlete gets 404.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { api, apiJson, bootstrapCoach, bootstrapTeam, uploadFile, type Session } from "./helpers";
import { count, FILE_BYTES, parseContentDisposition, post, rows, setupSquad, tracker } from "./tracker-fixtures";

import worker from "../../src/index";
import { getDb } from "../../src/db";
import { UPLOAD_MIME_TYPES } from "../../src/lib/validation";
import { backfillAttachmentSizes } from "../../src/services/attachments";
import { attemptBlobCleanup, enqueueBlobCleanup, runScheduledCleanup } from "../../src/services/cleanup";

const download = (session: Session | null, id: number) => api(`/api/plan/attachments/${id}/file`, { cookie: session?.cookie });

const upload = async (session: Session, overrides: Record<string, unknown> = {}) =>
  ((await (await uploadFile("/api/plan/sessions/files", session, overrides)).json()) as { id: number }).id;

async function expectFile(response: Response, mimeType: string): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(mimeType);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-length")).toBe(String(FILE_BYTES.byteLength));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE_BYTES);
}

async function expectHidden(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(await response.json()).toEqual({ error: "File not found" });
}

describe("attachment download headers", () => {
  it("sends the section 11 Content-Disposition for a label with non-ASCII and quote characters", async () => {
    const { athlete } = await setupSquad();
    const label = "Übungsplan \"Herbst\" 2026";
    const id = await upload(athlete, { label, mimeType: "application/pdf" });

    const response = await download(athlete, id);

    await expectFile(response, "application/pdf");
    const header = response.headers.get("content-disposition");
    const disposition = parseContentDisposition(header);
    // filename*: the real name, UTF-8 percent-encoded, with the MIME type's extension.
    expect(disposition.decoded).toBe(`${label}.pdf`);
    expect(disposition.encoded).toBe("%C3%9Cbungsplan%20%22Herbst%22%202026.pdf");
    // filename: printable ASCII only, no quote or backslash that could end the quoted string.
    expect(disposition.fallback).toMatch(/^[\x20-\x7E]+$/);
    expect(disposition.fallback).not.toMatch(/["\\]/);
    expect(disposition.fallback).toMatch(/bungsplan .Herbst. 2026\.pdf$/);
    // Nothing else in the header: exactly the three parts, in order.
    expect(header).toBe(`attachment; filename="${disposition.fallback}"; filename*=UTF-8''${disposition.encoded}`);
  });

  it.each([
    ["photo", "image/jpeg", "Anker 📸 photo", "Anker 📸 photo.jpg"],
    ["photo", "image/png", "練習メニュー", "練習メニュー.png"],
    ["photo", "image/heic", "IMG_0042.HEIC", "IMG_0042.heic"],
    ["document", "application/pdf", "plan.pdf", "plan.pdf"],
    ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Programme d'entraînement", "Programme d'entraînement.docx"],
  ])("a %s of type %s labelled %j downloads as %j", async (kind, mimeType, label, expected) => {
    const { athlete } = await setupSquad();
    const id = await upload(athlete, { kind, mimeType, label });

    const response = await download(athlete, id);

    await expectFile(response, mimeType);
    const disposition = parseContentDisposition(response.headers.get("content-disposition"));
    expect(disposition.decoded.toLowerCase()).toBe(expected.toLowerCase());
    expect(disposition.decoded.endsWith(expected.slice(expected.lastIndexOf(".")))).toBe(true);
    expect(disposition.fallback).toMatch(/^[\x20-\x7E]+$/);
    expect(disposition.fallback).not.toMatch(/["\\]/);
    expect(disposition.fallback.endsWith(expected.slice(expected.lastIndexOf(".")))).toBe(true);
  });

  it("a label cannot add header parameters, paths or a second header", async () => {
    const { athlete } = await setupSquad();
    const id = await upload(athlete, { label: "a\"; filename=\"evil.html\"; x=\"/../../b\\c" });

    const response = await download(athlete, id);

    await expectFile(response, "application/pdf");
    const header = response.headers.get("content-disposition") as string;
    const disposition = parseContentDisposition(header);
    // parseContentDisposition anchors the whole header grammar. Text such as
    // filename= inside the quoted value is not another parameter.
    expect(disposition.fallback).toContain("filename=");
    expect(disposition.fallback).not.toMatch(/["\\/]/);
    expect(disposition.decoded).not.toMatch(/[\\/]/);
    expect(disposition.decoded.endsWith(".pdf")).toBe(true);
  });

  it("the tracker payload links the file by its download route", async () => {
    const { athlete } = await setupSquad();
    const id = await upload(athlete, { dayKey: "fri", label: "Friday plan" });

    const payload = await tracker(athlete, { today: "2026-09-28" });

    expect(payload.plannedSessions.find((day) => day.dayKey === "fri")?.attachments).toMatchObject([
      { id, dayKey: "fri", kind: "document", label: "Friday plan", url: `/api/plan/attachments/${id}/file`, mimeType: "application/pdf" },
    ]);
  });
});

describe("attachment download access", () => {
  it("the owning athlete and every coach can download; another athlete gets 404", async () => {
    const { owner, coach, athlete, rival } = await setupSquad();
    const id = await upload(athlete, { label: "My plan" });

    await expectFile(await download(athlete, id), "application/pdf");
    await expectFile(await download(owner, id), "application/pdf");
    await expectFile(await download(coach, id), "application/pdf");
    await expectHidden(await download(rival, id));

    const anonymous = await download(null, id);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-disposition")).toBeNull();
    await anonymous.text();
  });

  it("the same headers reach the owner and a coach", async () => {
    const { coach, athlete } = await setupSquad();
    const id = await upload(athlete, { label: "Résumé \"final\"", mimeType: "image/webp", kind: "photo" });

    const own = await download(athlete, id);
    const viaCoach = await download(coach, id);

    expect(viaCoach.headers.get("content-disposition")).toBe(own.headers.get("content-disposition"));
    expect(parseContentDisposition(own.headers.get("content-disposition")).decoded).toBe("Résumé \"final\".webp");
    await own.arrayBuffer();
    await viaCoach.arrayBuffer();
  });

  it("a file a coach uploaded for an athlete belongs to that athlete", async () => {
    const { owner, coach, athlete, rival } = await setupSquad();
    const uploaded = await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach, { label: "From coach" });
    expect(uploaded.status).toBe(200);
    const id = ((await uploaded.json()) as { id: number }).id;

    await expectFile(await download(athlete, id), "application/pdf");
    await expectFile(await download(coach, id), "application/pdf");
    await expectFile(await download(owner, id), "application/pdf");
    await expectHidden(await download(rival, id));
    expect(await rows("SELECT user_id FROM planned_session_attachments WHERE id = ?", id)).toEqual([{ user_id: athlete.user.id }]);
  });

  it("a coach's own file is hidden from athletes and open to the other coach", async () => {
    const { owner, coach, athlete } = await setupSquad();
    const id = await upload(coach, { label: "Coach notes" });

    await expectFile(await download(coach, id), "application/pdf");
    await expectFile(await download(owner, id), "application/pdf");
    await expectHidden(await download(athlete, id));
  });

  it("an id that does not exist is the same 404 another athlete's file gives", async () => {
    const { athlete, rival } = await setupSquad();
    const id = await upload(athlete);

    const foreign = await apiJson(`/api/plan/attachments/${id}/file`, { cookie: rival.cookie });
    const missing = await apiJson(`/api/plan/attachments/${id + 500}/file`, { cookie: rival.cookie });

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it("links have no file to download, and a file whose blob is gone is a 404", async () => {
    const { coach, athlete } = await setupSquad();
    const link = (await post(athlete, "/api/plan/sessions/links", { dayKey: "mon", label: "Video", url: "https://example.org/v" })).id;
    const file = await upload(athlete);
    const stored = await rows<{ blob_key: string }>("SELECT blob_key FROM planned_session_attachments WHERE id = ?", file);
    await env.ATTACHMENTS.delete(stored[0]?.blob_key as string);

    for (const session of [athlete, coach]) {
      await expectHidden(await download(session, link));
      await expectHidden(await download(session, file));
    }
  });

  it("another athlete cannot delete the file they cannot download", async () => {
    const { athlete, rival } = await setupSquad();
    const id = await upload(athlete);

    const response = await apiJson(`/api/plan/attachments/${id}`, { method: "DELETE", cookie: rival.cookie });

    expect(response.status).toBe(404);
    expect(await count("planned_session_attachments", "id = ?", id)).toBe(1);
    await expectFile(await download(athlete, id), "application/pdf");
  });

  it.each(["0", "-1", "abc", "1.5"])("attachment id %s is a 400", async (id) => {
    const { athlete } = await setupSquad();
    const response = await apiJson(`/api/plan/attachments/${id}/file`, { cookie: athlete.cookie });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid attachment id" });
  });
});

// Direct Worker requests preserve deliberately false lengths; SELF's HTTP
// transport may normalize/reject these before the application can see them.
async function rawUpload(session: Session, body: ReadableStream | Uint8Array | File | null, headers: Record<string, string> = {}, bucket = env.ATTACHMENTS) {
  const size = body instanceof File ? body.size : body instanceof Uint8Array ? body.byteLength : undefined;
  const request = new Request("http://example.com/api/plan/sessions/files?dayKey=mon&kind=document&label=Plan", {
    method: "POST", body,
    headers: { origin: "http://example.com", cookie: session.cookie, "content-type": "application/pdf",
      ...(size === undefined ? {} : { "x-file-size": String(size) }), ...headers },
  });
  return worker.fetch(request, { ...env, ATTACHMENTS: bucket }, createExecutionContext());
}

function chunks(...sizes: number[]) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes.shift();
      if (size === undefined) controller.close();
      else controller.enqueue(new Uint8Array(size));
    },
  }, { highWaterMark: 0 });
}

async function seedFiles(userId: string, sizes: Array<number | null>) {
  await env.DB.batch(sizes.map((size, i) => env.DB.prepare(`INSERT INTO planned_session_attachments
    (user_id, day_key, kind, label, blob_key, mime_type, size_bytes, created_at)
    VALUES (?, 'mon', 'document', 'Seed', ?, 'application/pdf', ?, ?)`)
    .bind(userId, `seed/${i}`, size, Date.now())));
}

async function noUploadLeft() {
  expect((await env.ATTACHMENTS.list()).objects).toHaveLength(0);
  expect(await count("upload_reservations")).toBe(0);
  expect(await count("blob_cleanup")).toBe(0);
}

describe("raw uploads and accounting", () => {
  it.each(["text/html", "image/svg+xml", "application/json", "text/plain", "", "application/octet-stream"])("rejects %j with 415", async (mimeType) => {
    const session = await bootstrapCoach();
    const response = await rawUpload(session, FILE_BYTES, { "content-type": mimeType });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Unsupported file type" });
    await noUploadLeft();
  });

  it.each(UPLOAD_MIME_TYPES)("accepts allowlisted %s with normalized metadata", async (mimeType) => {
    const session = await bootstrapCoach();
    const response = await rawUpload(session, new File([FILE_BYTES], "plan", { type: mimeType }), { "content-type": ` ${mimeType.toUpperCase()}; charset=binary` });
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: number };
    expect(await rows("SELECT mime_type, size_bytes FROM planned_session_attachments WHERE id = ?", id))
      .toEqual([{ mime_type: mimeType, size_bytes: FILE_BYTES.length }]);
    await expectFile(await download(session, id), mimeType);
  });

  it.each(["8000001", "9007199254740992"])("rejects declared oversize %s before pulling a byte", async (length) => {
    const session = await bootstrapCoach();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(FILE_BYTES); c.close(); } }, { highWaterMark: 0 });
    const response = await rawUpload(session, body, { "content-length": length });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Attachment is larger than 8 MB" });
    expect(pulled).toBe(false);
    await noUploadLeft();
  });

  it.each([
    ["longer than declared", [3, 3], "5", 400, "File size does not match Content-Length"],
    ["truncated", [3], "5", 400, "File size does not match Content-Length"],
    ["missing length metadata", [4_000_000, 4_000_001], null, 400, "Content-Length or X-File-Size is required"],
    ["over cap with false length", [4_000_000, 4_000_001], "8000000", 413, "Attachment is larger than 8 MB"],
    ["empty", [], "0", 400, "File body is required"],
  ] as const)("rejects a stream %s and leaves no blob", async (_name, sizes, length, status, error) => {
    const session = await bootstrapCoach();
    const response = await rawUpload(session, chunks(...sizes), length === null ? {} : { "content-length": length });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    await noUploadLeft();
  });

  it.each(["-1", "abc", "1.5"])("rejects invalid length %s", async (length) => {
    const response = await rawUpload(await bootstrapCoach(), chunks(1), { "content-length": length });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Content-Length" });
  });

  it("accepts browser size metadata without Content-Length, an exact length, and exactly 8 MB", async () => {
    const session = await bootstrapCoach();
    for (const [sizes, headers] of [[[2, 3], { "x-file-size": "5" }], [[2, 3], { "content-length": "5" }], [[4_000_000, 4_000_000], { "x-file-size": "8000000" }]] as const) {
      const response = await rawUpload(session, chunks(...sizes), headers);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(await rows("SELECT size_bytes FROM planned_session_attachments ORDER BY id")).toEqual([{ size_bytes: 5 }, { size_bytes: 5 }, { size_bytes: 8_000_000 }]);
  });

  it("rejects the 101st file, while links and deletion still work", async () => {
    const session = await bootstrapCoach();
    await seedFiles(session.user.id, Array(100).fill(1));
    const response = await rawUpload(session, FILE_BYTES);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "File limit reached (100 files per user)" });
    await post(session, "/api/plan/sessions/links", { dayKey: "mon", label: "Link", url: "https://example.com" });
    const [first] = await rows<{ id: number }>("SELECT id FROM planned_session_attachments ORDER BY id LIMIT 1");
    const deleted = await api(`/api/plan/attachments/${first.id}`, { method: "DELETE", cookie: session.cookie });
    expect(deleted.status).toBe(200);
    await deleted.text();
    expect((await uploadFile("/api/plan/sessions/files", session)).status).toBe(200);
  });

  it("rejects the byte past 500 MB and permits the exact boundary", async () => {
    const session = await bootstrapCoach();
    await seedFiles(session.user.id, [499_999_999]);
    const first = await rawUpload(session, chunks(1), { "x-file-size": "1" });
    expect(first.status).toBe(200);
    await first.text();
    const response = await rawUpload(session, chunks(1), { "x-file-size": "1" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Storage limit reached (500 MB per user)" });
  });

  it("charges coach uploads to the athlete, including a deactivated athlete", async () => {
    const { coach, athlete } = await bootstrapTeam();
    await seedFiles(coach.user.id, [500_000_000]);
    await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE id = ?").bind(Date.now(), athlete.user.id).run();
    const path = `/api/coach/athletes/${athlete.user.id}/plan/sessions/files`;
    const accepted = await uploadFile(path, coach);
    expect(accepted.status).toBe(200);
    await accepted.text();
    await env.DB.prepare("UPDATE planned_session_attachments SET size_bytes = 500000000 WHERE user_id = ?").bind(athlete.user.id).run();
    const response = await uploadFile(path, coach);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Storage limit reached (500 MB per user)" });
  });

  it.each(["files", "bytes"])("atomic reservations stop concurrent uploads at the %s boundary", async (boundary) => {
    const session = await bootstrapCoach();
    await seedFiles(session.user.id, boundary === "files" ? Array(99).fill(1) : [499_999_999]);
    const responses = await Promise.all([rawUpload(session, chunks(1), { "x-file-size": "1" }), rawUpload(session, chunks(1), { "x-file-size": "1" })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 413]);
    await Promise.all(responses.map(r => r.text()));
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(1);
    expect(await count("upload_reservations")).toBe(0);
  });

  it("returns only Upload failed on an R2 failure and releases the reservation", async () => {
    const session = await bootstrapCoach();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bucket = bucketWith({ put: async () => { throw new Error("secret upstream token"); } });
      const response = await rawUpload(session, FILE_BYTES, {}, bucket);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Upload failed" });
      expect(errorLog).toHaveBeenCalledWith("Upload failed");
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret upstream token");
      await noUploadLeft();
    } finally { errorLog.mockRestore(); }
  });

  it("rate limits the acting coach, and raw uploads still require same-origin proof", async () => {
    const { coach, athlete } = await bootstrapTeam();
    env.RATE_LIMIT_MODE = `deny:upload:${coach.user.id}`;
    try {
      const response = await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach);
      expect(response.status).toBe(429);
      await response.text();
    } finally { env.RATE_LIMIT_MODE = "allow"; }
    const rejected = await api("/api/plan/sessions/files?dayKey=mon&kind=document&label=Plan", {
      cookie: coach.cookie, body: FILE_BYTES, origin: "https://evil.test", headers: { "content-type": "application/pdf" },
    });
    expect(rejected.status).toBe(403);
    await rejected.text();
  });

  it("sanitizes legacy download MIME and filename together", async () => {
    const session = await bootstrapCoach();
    const id = await upload(session);
    await env.DB.prepare("UPDATE planned_session_attachments SET mime_type = 'text/html', label = 'evil.html' WHERE id = ?").bind(id).run();
    const response = await download(session, id);
    await expectFile(response, "application/octet-stream");
    expect(parseContentDisposition(response.headers.get("content-disposition")).decoded).toBe("evil.bin");
  });
});

function bucketWith(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.ATTACHMENTS, { get(target, prop) {
    if (prop in overrides) return Reflect.get(overrides, prop);
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("upload recovery and size backfill", () => {
  it.each([false, true])("cleanup fences only expired uploads (expired=%s)", async (expired) => {
    const session = await bootstrapCoach();
    const bucket = bucketWith({ put: async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await env.ATTACHMENTS.put(...args);
      if (expired) await runScheduledCleanup(env, new Date(Date.now() + 3600_001));
      else await attemptBlobCleanup(getDb(env.DB), env.ATTACHMENTS, [args[0]]);
      return result;
    } });
    const response = await rawUpload(session, FILE_BYTES, {}, bucket);
    expect(response.status).toBe(expired ? 400 : 200);
    await response.text();
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(expired ? 0 : 1);
    expect(await count("upload_reservations")).toBe(0);
    expect(await count("blob_cleanup")).toBe(0);
  });

  it.each(["deactivate", "delete", "D1 failure"])("cleans the blob when %s happens during put", async (action) => {
    const { athlete } = await bootstrapTeam();
    const bucket = bucketWith({ put: async (...args: Parameters<R2Bucket["put"]>) => {
      const object = await env.ATTACHMENTS.put(...args);
      if (action === "delete") await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(athlete.user.id).run();
      else if (action === "deactivate") await env.DB.prepare("UPDATE users SET deactivated_at = ? WHERE id = ?").bind(Date.now(), athlete.user.id).run();
      else await env.DB.exec("CREATE TRIGGER fail_upload BEFORE INSERT ON planned_session_attachments BEGIN SELECT RAISE(ABORT, 'private database error'); END");
      return object;
    } });
    try {
      const response = await rawUpload(athlete, FILE_BYTES, {}, bucket);
      expect(response.status).toBe(action === "D1 failure" ? 500 : 400);
      if (action === "D1 failure") expect(await response.json()).toEqual({ error: "Upload failed" });
      else await response.text();
      await noUploadLeft();
    } finally { await env.DB.exec("DROP TRIGGER IF EXISTS fail_upload"); }
  });

  it("retains durable cleanup on deletion failure, then retries", async () => {
    const session = await bootstrapCoach();
    const bucket = bucketWith({
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        await env.ATTACHMENTS.put(...args);
        throw new Error("R2 ambiguous failure");
      },
      delete: async () => { throw new Error("R2 delete failure"); },
    });
    const response = await rawUpload(session, FILE_BYTES, {}, bucket);
    expect(response.status).toBe(500);
    await response.text();
    expect(await count("upload_reservations")).toBe(0);
    expect(await count("blob_cleanup")).toBe(1);
    await runScheduledCleanup(env, new Date(Date.now() + 3600_000));
    await noUploadLeft();
  });

  it("expired reservations release quota and preserve recovery for a late put", async () => {
    const session = await bootstrapCoach();
    const now = new Date();
    await env.DB.prepare("INSERT INTO upload_reservations VALUES ('abandoned', ?, ?, 500000000, ?)")
      .bind(session.user.id, session.user.id, now.getTime() - 1).run();
    await enqueueBlobCleanup(getDb(env.DB), ["abandoned"], { reason: "upload", notBefore: now })[0];
    await runScheduledCleanup(env, now); // first delete happens before put finishes
    expect(await count("blob_cleanup")).toBe(1);
    await env.ATTACHMENTS.put("abandoned", FILE_BYTES);
    await runScheduledCleanup(env, new Date(now.getTime() + 86400_000));
    expect(await env.ATTACHMENTS.head("abandoned")).toBeNull();
    const response = await rawUpload(session, FILE_BYTES);
    expect(response.status).toBe(200);
    await response.text();
  });

  it("backfills in bounded resumable batches; unknown/missing never count as zero", async () => {
    const session = await bootstrapCoach();
    await seedFiles(session.user.id, [null, null]);
    await env.ATTACHMENTS.put("seed/0", FILE_BYTES);
    const blocked = await rawUpload(session, FILE_BYTES);
    expect(blocked.status).toBe(413);
    expect(await blocked.json()).toEqual({ error: "Upload accounting is incomplete; wait for backfill or delete unavailable files" });
    const db = getDb(env.DB);
    expect(await backfillAttachmentSizes(db, env.ATTACHMENTS, new Date(), 1)).toEqual({ updated: 1, missing: 0, failed: 0 });
    expect(await backfillAttachmentSizes(db, env.ATTACHMENTS, new Date(), 1)).toEqual({ updated: 0, missing: 1, failed: 0 });
    const stillBlocked = await rawUpload(session, FILE_BYTES);
    expect(stillBlocked.status).toBe(413);
    await stillBlocked.text();
    await env.ATTACHMENTS.put("seed/1", FILE_BYTES);
    expect((await runScheduledCleanup(env)).backfill.updated).toBe(1);
    expect(await backfillAttachmentSizes(db, env.ATTACHMENTS)).toEqual({ updated: 0, missing: 0, failed: 0 });
    const accepted = await rawUpload(session, FILE_BYTES);
    expect(accepted.status).toBe(200);
    await accepted.text();
  });

  it("failed heads rotate behind unattempted rows without completing accounting", async () => {
    const session = await bootstrapCoach();
    await seedFiles(session.user.id, [null, null]);
    await env.ATTACHMENTS.put("seed/1", FILE_BYTES);
    const bucket = bucketWith({ head: async () => { throw new Error("private head error"); } });
    expect((await backfillAttachmentSizes(getDb(env.DB), bucket, new Date(), 1)).failed).toBe(1);
    expect((await backfillAttachmentSizes(getDb(env.DB), env.ATTACHMENTS, new Date(), 1)).updated).toBe(1);
    const response = await rawUpload(session, FILE_BYTES);
    expect(response.status).toBe(413);
    await response.text();
  });
});

it("R2 starts consuming the stream before request EOF, with no full-file buffer", async () => {
  const session = await bootstrapCoach();
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  let putStarted = false;
  let eof = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    if (pulls++ === 0) { c.enqueue(new Uint8Array([1, 2, 3])); return; }
    await resume;
    c.enqueue(new Uint8Array([4, 5])); eof = true; c.close();
  } }, { highWaterMark: 0 });
  const bucket = bucketWith({ put: async (key, value, options) => {
    expect(value).toBeInstanceOf(ReadableStream);
    expect(eof).toBe(false);
    putStarted = true;
    return env.ATTACHMENTS.put(key, value, options);
  } });
  const pending = rawUpload(session, body, { "x-file-size": "5" }, bucket);
  try {
    await vi.waitFor(() => expect(putStarted).toBe(true));
    expect(eof).toBe(false);
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    const key = (await env.ATTACHMENTS.list()).objects[0].key;
    expect(new Uint8Array(await (await env.ATTACHMENTS.get(key))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  } finally { release(); await pending; }
});

it("a failing body source releases its reservation and leaves no permanent blob", async () => {
  const session = await bootstrapCoach();
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (chunks++ === 0) c.enqueue(new Uint8Array([1, 2, 3]));
    else c.error(new Error("private source details"));
  } }, { highWaterMark: 0 });
  const response = await rawUpload(session, body, { "x-file-size": "5" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "File upload was interrupted" });
  await noUploadLeft();
});

it("rejects conflicting browser size metadata without consuming the body", async () => {
  let read = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { read = true; c.close(); } }, { highWaterMark: 0 });
  const response = await rawUpload(await bootstrapCoach(), body, { "x-file-size": "5", "content-length": "6" });
  expect(response.status).toBe(400);
  expect(read).toBe(false);
  await noUploadLeft();
});
