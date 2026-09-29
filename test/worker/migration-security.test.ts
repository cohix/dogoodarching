import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { getDb } from "../../src/db";
import { hashPassword, sha256Hex } from "../../src/lib/auth";
import { backfillAttachmentSizes } from "../../src/services/attachments";
import { api, DEFAULT_PASSWORD, login, uploadFile } from "./helpers";
import { applyLaterMigrations, applyMigration, columnNames, columns, count, fkCheck, foreignKeys, indexNames, migration, rewindTo0001, userTables } from "./migration-fixtures";

it("new migrations preserve populated 0002 users, invites, sessions and files; size backfill is bounded and repeatable", async () => {
  await rewindTo0001();
  await applyMigration(migration("0002"));
  const now = Date.now();
  const hash = await hashPassword(DEFAULT_PASSWORD);
  const inviteToken = "a".repeat(64);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('owner','owner',?,'coach',1,NULL,?)").bind(hash,now),
    env.DB.prepare("INSERT INTO users VALUES ('athlete','athlete',?,'athlete',0,'owner',?)").bind(hash,now),
    env.DB.prepare("INSERT INTO sessions VALUES ('old-session',?,'athlete',?,?)").bind(await sha256Hex("old-session-token"),now+86400000,now),
    env.DB.prepare("INSERT INTO invites VALUES ('pending',?,'owner','athlete',?,NULL,?)").bind(await sha256Hex(inviteToken),now+86400000,now),
    env.DB.prepare("INSERT INTO program_state VALUES ('athlete',NULL,2,3,?)").bind(now),
    env.DB.prepare("INSERT INTO training_sessions (user_id,session_date,session_type,notes,created_at) VALUES ('athlete','2026-09-21','Range','preserve this',?)").bind(now),
    env.DB.prepare("INSERT INTO rate_limits VALUES ('login:ip',2,?)").bind(now),
    env.DB.prepare("INSERT INTO planned_session_attachments (id,user_id,day_key,kind,label,blob_key,mime_type,created_at) VALUES (1,'athlete','mon','document','existing','old-file','application/pdf',?)").bind(now),
    env.DB.prepare("INSERT INTO planned_session_attachments (id,user_id,day_key,kind,label,blob_key,mime_type,created_at) VALUES (2,'athlete','tue','document','missing','missing-file','application/pdf',?)").bind(now),
    env.DB.prepare("INSERT INTO planned_session_attachments (id,user_id,day_key,kind,label,url,created_at) VALUES (3,'athlete','wed','link','link','https://example.com',?)").bind(now),
  ]);
  await env.ATTACHMENTS.put("old-file", "1234567");
  const snapshot = async (table: string) => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  const before: Record<string, Record<string, unknown>[]> = Object.fromEntries(await Promise.all(["users","invites","sessions","training_sessions","program_state","planned_session_attachments"].map(async table => [table,await snapshot(table)])));
  await applyLaterMigrations();
  expect(await userTables()).not.toContain("rate_limits");
  expect(await userTables()).toEqual(expect.arrayContaining(["blob_cleanup","upload_reservations"]));
  expect(await columnNames("users")).toContain("deactivated_at");
  expect((await columns("users")).find(c => c.name === "deactivated_at")!.notnull).toBe(0);
  expect(await columnNames("planned_session_attachments")).toEqual(expect.arrayContaining(["size_bytes","size_checked_at"]));
  expect(await columnNames("blob_cleanup")).toEqual(["blob_key","reason","attempts","last_error","next_attempt_at","created_at"]);
  expect(await columnNames("upload_reservations")).toEqual(["blob_key","user_id","actor_id","size_bytes","expires_at"]);
  expect(await foreignKeys("blob_cleanup")).toEqual([]);
  expect(await indexNames("users")).toContain("users_one_owner_unique");
  expect(await fkCheck()).toEqual([]);
  for (const table of ["invites","sessions","training_sessions","program_state"]) expect(await snapshot(table)).toEqual(before[table]);
  expect(await snapshot("users")).toEqual(before.users!.map(row => ({ ...row,deactivated_at: null })));
  expect(await snapshot("planned_session_attachments")).toEqual(before.planned_session_attachments!.map(row => ({ ...row,size_bytes:null,size_checked_at:null })));
  expect(await count("blob_cleanup")).toBe(0);
  expect(await count("upload_reservations")).toBe(0);
  expect((await api("/api/auth/me", { cookie: "dga_session=old-session-token" })).status).toBe(200);
  expect((await login("owner")).user.isOwner).toBe(true);
  const athlete = await login("athlete");
  // Unknown legacy sizes must block admission, even though no bytes are known.
  expect((await uploadFile("/api/plan/sessions/files", athlete)).status).toBe(413);
  const db = getDb(env.DB);
  const time = new Date("2030-01-01T00:00:00Z");
  const head = vi.spyOn(env.ATTACHMENTS,"head");
  try {
    expect(await backfillAttachmentSizes(db,env.ATTACHMENTS,time,1)).toEqual({ updated:1,missing:0,failed:0 });
    expect(head).toHaveBeenCalledExactlyOnceWith("old-file");
    const known = await env.DB.prepare("SELECT size_bytes,size_checked_at FROM planned_session_attachments WHERE id=1").first();
    expect(known).toEqual({ size_bytes:7,size_checked_at:time.getTime() });
    head.mockClear();
    expect(await backfillAttachmentSizes(db,env.ATTACHMENTS,time)).toEqual({ updated:0,missing:1,failed:0 });
    expect(head).toHaveBeenCalledExactlyOnceWith("missing-file");
    expect(await backfillAttachmentSizes(db,env.ATTACHMENTS,time)).toEqual({ updated:0,missing:1,failed:0 });
    expect(await env.DB.prepare("SELECT size_bytes,size_checked_at FROM planned_session_attachments WHERE id=1").first()).toEqual(known);
    expect((await uploadFile("/api/plan/sessions/files",athlete)).status).toBe(413);
    await env.ATTACHMENTS.put("missing-file","restored");
    expect(await backfillAttachmentSizes(db,env.ATTACHMENTS,time)).toEqual({ updated:1,missing:0,failed:0 });
    expect(await backfillAttachmentSizes(db,env.ATTACHMENTS,time)).toEqual({ updated:0,missing:0,failed:0 });
    expect((await uploadFile("/api/plan/sessions/files",athlete)).status).toBe(200);
    expect(await (await api("/api/auth/accept-invite", { json: { token:inviteToken,username:"new-athlete",password:DEFAULT_PASSWORD } })).json()).toMatchObject({ username:"new-athlete",isOwner:false });
  } finally { head.mockRestore(); }
});
