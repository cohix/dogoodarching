/**
 * Work item 0001 section 11 (A10) and section 13: attachment downloads send
 * `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>`
 * with the extension that matches the MIME type. The attachment's owner and
 * any coach can download; another athlete gets 404.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, apiJson, type Session } from "./helpers";
import { count, FILE_BYTES, fileBody, parseContentDisposition, post, rows, setupSquad, tracker } from "./tracker-fixtures";

const download = (session: Session | null, id: number) => api(`/api/plan/attachments/${id}/file`, { cookie: session?.cookie });

const upload = async (session: Session, overrides: Record<string, unknown> = {}) =>
  (await post(session, "/api/plan/sessions/files", fileBody(overrides))).id;

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
    ["document", "text/plain", "notes", "notes.txt"],
    ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Programme d'entraînement", "Programme d'entraînement.docx"],
    ["document", "application/x-unknown-type", "mystery", "mystery.bin"],
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
    const uploaded = await apiJson<{ id: number }>(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, { json: fileBody({ label: "From coach" }), cookie: coach.cookie });
    expect(uploaded.status).toBe(200);
    const id = uploaded.body.id;

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
