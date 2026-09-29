import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, } from "vitest";
import worker from "../../src/index";
import { getDb } from "../../src/db";
import { importPayloadSchema, type ImportData } from "../../src/lib/validation";
import { datedProgramState, MAX_PROGRAM_CYCLES } from "../../src/lib/dates";
import { exportUserData, importUserData, MAX_IMPORT_BYTES, preflightImport } from "../../src/services/transfer";
import { attemptBlobCleanup } from "../../src/services/cleanup";
import { api, bootstrapTeam, uploadFile, type Session } from "./helpers";
import { interceptD1, rendezvous } from "./security-auth-fixtures";

const at = "2026-09-28T12:00:00.000Z";
function validData(): ImportData {
  return {
    trainingSessions: [{ id: 1, sessionDate: "2024-02-29", sessionType: "Range", customActivity: "", arrows: 30, durationMinutes: 60, focus: "", score: "", notes: "private", createdAt: at }],
    practiceScores: [{ id: 1, scoreDate: "2024-02-29", total: 240, createdAt: at }],
    practiceScoreEnds: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, scoreId: 1, endNumber: i + 1, arrow1: 8, arrow2: 8, arrow3: 8, endTotal: 24 })),
    programState: { currentPoundage: null, currentCycle: 1, currentWeek: 1, updatedAt: at },
    cycleWeekPlans: [{ weekNumber: 1, primaryFocus: "Anchor", backgroundFocusOne: "", backgroundFocusTwo: "", updatedAt: at }],
    plannedSessionOverrides: [{ dayKey: "mon", sessionType: "Range", detail: "Practice", prescription: "Shoot", updatedAt: at }],
    plannedSessionAttachments: [{ id: 1, dayKey: "mon", kind: "link", label: "Video", url: "https://example.com", mimeType: "text/uri-list", createdAt: at }],
    milestoneChecks: [{ key: "first", checked: true, updatedAt: at }],
    maintenanceItems: [{ id: 1, section: "Weekly", label: "String", sortOrder: 0, createdAt: at, updatedAt: at }],
    maintenanceChecks: [{ key: "item:1", checked: true, updatedAt: at }, { key: "legacy-key", checked: false, updatedAt: at }],
    inspirationEntries: [{ id: 1, thoughtText: "Focus", videoTitle: "Video", videoUrl: "https://example.com", recipeName: "Meal", recipeSummary: "Good", recipeIngredients: "Oats", recipeInstructions: "Mix", updatedAt: at }],
    weeklyNotes: [{ id: 1, weekStart: "2024-02-26", notes: "Week", createdAt: at, updatedAt: at }],
    bowSetups: [{ id: 1, poundage: 25, name: "Bow", limbRiser: "", tillerBolts: "", braceHeight: "", stringTwists: "", nockingPoint: "", centerShot: "", plunger: "", gripNotes: "", stabilizer: "", clickerPosition: "", bareShaft: "", walkBack: "", arrowsInUse: "", sightMarksJson: '{"20m":"4"}', updatedAt: at }],
  };
}
function emptyData(): ImportData {
  const data = validData();
  for (const name of Object.keys(data) as (keyof ImportData)[]) {
    if (name === "programState") data.programState = null;
    else data[name] = [];
  }
  return data;
}
const exported = (session: Session) => exportUserData(getDb(env.DB), session.user.id, session.user.username);
const replace = (session: Session, data: ImportData) => api("/api/import", { cookie: session.cookie, json: { version: 1, data } });

const invalid: [string, (d: ImportData) => void, string][] = [
  ["javascript URL", d => { d.plannedSessionAttachments[0].url = "javascript:alert(1)"; }, "plannedSessionAttachments.0.url"],
  ["data video URL", d => { d.inspirationEntries[0].videoUrl = "data:text/html,hi"; }, "inspirationEntries.0.videoUrl"],
  ["impossible date", d => { d.trainingSessions[0].sessionDate = "2026-02-30"; }, "trainingSessions.0.sessionDate"],
  ["long focus", d => { d.trainingSessions[0].focus = "x".repeat(201); }, "trainingSessions.0.focus"],
  ["negative arrows", d => { d.trainingSessions[0].arrows = -1; }, "trainingSessions.0.arrows"],
  ["long duration", d => { d.trainingSessions[0].durationMinutes = 1441; }, "trainingSessions.0.durationMinutes"],
  ["bad week", d => { d.programState!.currentWeek = 7; }, "programState.currentWeek"],
  ["large cycle", d => { d.programState!.currentCycle = 1_000_000; }, "programState.currentCycle"],
  ["zero cycle", d => { d.programState!.currentCycle = 0; }, "programState.currentCycle"],
  ["large poundage", d => { d.programState!.currentPoundage = 101; }, "programState.currentPoundage"],
  ["bad sight marks", d => { d.bowSetups[0].sightMarksJson = "null"; }, "bowSetups.0.sightMarksJson"],
  ["nonstring sight mark", d => { d.bowSetups[0].sightMarksJson = '{"a":1}'; }, "bowSetups.0.sightMarksJson"],
  ["score total", d => { d.practiceScores[0].total = 241; }, "practiceScores.0.total"],
  ["end total", d => { d.practiceScoreEnds[0].endTotal = 25; }, "practiceScoreEnds.0.endTotal"],
  ["arrow range", d => { d.practiceScoreEnds[0].arrow1 = 11; }, "practiceScoreEnds.0.arrow1"],
  ["missing end", d => { d.practiceScoreEnds.pop(); }, "practiceScores.0"],
  ["duplicate end", d => { d.practiceScoreEnds[1].endNumber = 1; }, "practiceScoreEnds.1.endNumber"],
  ["orphan end", d => { d.practiceScoreEnds[0].scoreId = 99; }, "practiceScoreEnds.0.scoreId"],
  ["orphan check", d => { d.maintenanceChecks[0].key = "item:99"; }, "maintenanceChecks.0.key"],
  ["duplicate day", d => { d.plannedSessionOverrides.push({ ...d.plannedSessionOverrides[0] }); }, "plannedSessionOverrides.1.dayKey"],
  ["duplicate week", d => { d.cycleWeekPlans.push({ ...d.cycleWeekPlans[0] }); }, "cycleWeekPlans.1.weekNumber"],
  ["duplicate milestone", d => { d.milestoneChecks.push({ ...d.milestoneChecks[0] }); }, "milestoneChecks.1.key"],
  ["duplicate maintenance check", d => { d.maintenanceChecks.push({ ...d.maintenanceChecks[0] }); }, "maintenanceChecks.2.key"],
  ["duplicate weekly note", d => { d.weeklyNotes.push({ ...d.weeklyNotes[0], id: 2 }); }, "weeklyNotes.1.weekStart"],
];
describe("shared import validation", () => {
  it.each(invalid)("rejects %s with indexed errors before any side effect", async (_name, mutate, path) => {
    const { athlete } = await bootstrapTeam();
    await uploadFile("/api/plan/sessions/files", athlete);
    const before = await exported(athlete);
    const blobs = await env.ATTACHMENTS.list();
    const data = validData(); mutate(data);
    const response = await replace(athlete, data);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain(`data.${path}`);
    expect(await exported(athlete)).toMatchObject({ data: before.data });
    expect((await env.ATTACHMENTS.list()).objects.map(o => o.key)).toEqual(blobs.objects.map(o => o.key));
    expect((await env.DB.prepare("SELECT * FROM blob_cleanup").all()).results).toEqual([]);
  });
  it("rejects duplicate source ids in every ID-bearing array and non-link attachments", () => {
    const data = validData();
    for (const [name, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || !rows.length || !("id" in rows[0])) continue;
      const changed = { ...data, [name]: [...rows, rows[0]] };
      expect(importPayloadSchema.safeParse({ version: 1, data: changed }).success, name).toBe(false);
    }
    expect(importPayloadSchema.safeParse({ version: 1, data: { ...data, plannedSessionAttachments: [{ ...data.plannedSessionAttachments[0], kind: "photo" }] } }).success).toBe(false);
  });
  it("enforces every array cap", () => {
    const data = validData();
    const caps: Record<string, number> = { trainingSessions: 20000, practiceScores: 5000, practiceScoreEnds: 50000, cycleWeekPlans: 6, plannedSessionOverrides: 7, plannedSessionAttachments: 5000, milestoneChecks: 5000, maintenanceChecks: 5000, maintenanceItems: 5000, inspirationEntries: 5000, weeklyNotes: 5000, bowSetups: 1000 };
    for (const [name, cap] of Object.entries(caps)) {
      const rows = data[name as keyof ImportData];
      if (!Array.isArray(rows)) throw new Error(name);
      const parsed = importPayloadSchema.safeParse({ version: 1, data: { ...data, [name]: Array(cap + 1).fill(rows[0]) } });
      expect(parsed.success, name).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some(i => i.code === "too_big" && i.path.join(".") === `data.${name}`), name).toBe(true);
    }
  });
  it("bounds elapsed calendar advancement and summary allocation", () => {
    expect(datedProgramState({ currentCycle: 1, currentWeek: 1, updatedAt: new Date("0001-01-01T12:00:00Z") }, "9999-12-31")).toEqual({ currentCycle: MAX_PROGRAM_CYCLES, currentWeek: 6 });
  });
});

it("round-trips null poundage, supports null state/legacy entries, and empty replacement clears data", async () => {
  const { athlete } = await bootstrapTeam();
  expect((await replace(athlete, validData())).status).toBe(200);
  const first = await exported(athlete);
  expect(first.data.programState?.currentPoundage).toBeNull();
  expect((await api("/api/import", { cookie: athlete.cookie, json: { ...first, data: { ...first.data, entries: ["ignored"] } } })).status).toBe(200);
  await uploadFile("/api/plan/sessions/files", athlete);
  expect((await replace(athlete, emptyData())).status).toBe(200);
  expect((await exported(athlete)).data).toEqual(emptyData());
  expect((await env.ATTACHMENTS.list()).objects).toEqual([]);
  expect((await api("/api/import", { cookie: athlete.cookie, json: {} })).status).toBe(400);
});

it("late D1 failure rolls back rows, parent mappings and cleanup without touching referenced R2", async () => {
  const { athlete } = await bootstrapTeam();
  await replace(athlete, validData());
  await uploadFile("/api/plan/sessions/files", athlete);
  const before = await exported(athlete);
  const blobs = (await env.ATTACHMENTS.list()).objects;
  await env.DB.exec("CREATE TRIGGER fail_import BEFORE INSERT ON program_state BEGIN SELECT RAISE(ABORT, 'forced late failure'); END");
  try { expect((await replace(athlete, validData())).status).toBe(500); }
  finally { await env.DB.exec("DROP TRIGGER fail_import"); }
  expect((await exported(athlete)).data).toEqual(before.data);
  for (const blob of blobs) expect(await env.ATTACHMENTS.head(blob.key)).not.toBeNull();
  expect((await env.DB.prepare("SELECT * FROM blob_cleanup").all()).results).toEqual([]);
  expect((await env.DB.prepare("SELECT import_key FROM practice_scores UNION ALL SELECT import_key FROM maintenance_items").all()).results.every(r => r.import_key === null)).toBe(true);
});

it("post-commit R2 failure is successful import with durable retry", async () => {
  const { athlete } = await bootstrapTeam();
  await uploadFile("/api/plan/sessions/files", athlete);
  const key = (await env.ATTACHMENTS.list()).objects[0].key;
  const real = env.ATTACHMENTS;
  const bucket = new Proxy(real, { get(target, prop) { return prop === "delete" ? async () => { throw new Error("fault"); } : typeof Reflect.get(target, prop) === "function" ? Reflect.get(target, prop).bind(target) : Reflect.get(target, prop); } });
  expect((await importUserData(getDb(env.DB), bucket, athlete.user.id, emptyData())).ok).toBe(true);
  expect(await real.head(key)).not.toBeNull();
  expect((await env.DB.prepare("SELECT attempts FROM blob_cleanup WHERE blob_key = ?").bind(key).first())?.attempts).toBe(1);
  await attemptBlobCleanup(getDb(env.DB), real, [key]);
  expect(await real.head(key)).toBeNull();
});

it.each(["deactivate", "delete"])("fences an in-flight import after actor %s", async action => {
  const { athlete, coach } = await bootstrapTeam();
  await uploadFile("/api/plan/sessions/files", athlete);
  const real = env.DB, paused = rendezvous(), resume = rendezvous(); let gated = false;
  const db = interceptD1(real, async (query, phase) => {
    if (!gated && phase === "before" && /delete from "practice_score_ends"/i.test(query)) { gated = true; paused.release(); await resume.reached; }
  });
  const pending = importUserData(getDb(db), env.ATTACHMENTS, athlete.user.id, validData()).then(() => null, error => error);
  try {
    await paused.reached;
    if (action === "deactivate") await api(`/api/coach/athletes/${athlete.user.id}/deactivate`, { cookie: coach.cookie, method: "POST" });
    else await real.prepare("DELETE FROM users WHERE id = ?").bind(athlete.user.id).run();
    resume.release(); expect(await pending).toMatchObject({ status: 401 });
    expect((await real.prepare("SELECT * FROM training_sessions").all()).results).toEqual([]);
  } finally { resume.release(); await pending; }
});

it("captures a coach upload committed just before replacement and keeps one committed afterward", async () => {
  const { athlete, coach } = await bootstrapTeam();
  const paused = rendezvous(), resume = rendezvous(); let gated = false;
  const db = interceptD1(env.DB, async (query, phase) => {
    if (!gated && phase === "before" && /delete from "practice_score_ends"/i.test(query)) { gated = true; paused.release(); await resume.reached; }
  });
  const pending = importUserData(getDb(db), env.ATTACHMENTS, athlete.user.id, emptyData());
  try {
    await paused.reached;
    expect((await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach)).status).toBe(200);
    const key = (await env.ATTACHMENTS.list()).objects[0].key;
    resume.release(); await pending;
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect((await uploadFile(`/api/coach/athletes/${athlete.user.id}/plan/sessions/files`, coach)).status).toBe(200);
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(1);
  } finally { resume.release(); await pending; }
});

it("concurrent imports and ordinary inserts use independent generated IDs and parent mappings", async () => {
  const { athlete, coach } = await bootstrapTeam();
  const data = validData();
  data.practiceScores.push({ ...data.practiceScores[0], id: 2 });
  data.practiceScoreEnds.push(...data.practiceScoreEnds.map(e => ({ ...e, id: e.id + 10, scoreId: 2 })));
  data.maintenanceItems.push({ ...data.maintenanceItems[0], id: 2 });
  data.maintenanceChecks.push({ key: "item:2", checked: false, updatedAt: at });
  const paused = rendezvous(), resume = rendezvous(); let gated = false;
  const db = interceptD1(env.DB, async (query, phase) => {
    if (!gated && phase === "before" && /delete from "practice_score_ends"/i.test(query)) { gated = true; paused.release(); await resume.reached; }
  });
  const pending = importUserData(getDb(db), env.ATTACHMENTS, athlete.user.id, data);
  try {
    await paused.reached;
    await importUserData(getDb(env.DB), env.ATTACHMENTS, coach.user.id, data);
    await env.DB.prepare("INSERT INTO training_sessions(user_id,session_date,session_type,created_at) VALUES (?, '2026-09-28','Range',?)").bind(coach.user.id, Date.now()).run();
    resume.release(); await pending;
    for (const session of [athlete, coach]) {
      const result = (await exported(session)).data;
      expect(result.practiceScores).toHaveLength(2);
      expect(result.maintenanceItems).toHaveLength(2);
      for (const score of result.practiceScores) expect(result.practiceScoreEnds.filter(e => e.scoreId === score.id)).toHaveLength(10);
      for (const item of result.maintenanceItems) expect(result.maintenanceChecks.some(c => c.key === `item:${item.id}`)).toBe(true);
    }
    expect((await exported(coach)).data.trainingSessions).toHaveLength(2);
  } finally { resume.release(); await pending; }
});

it.each([undefined, "1", String(MAX_IMPORT_BYTES + 1)])("caps actual import bytes with declared length %s before parsing/writing", async length => {
  const { athlete } = await bootstrapTeam();
  const before = await exported(athlete);
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(MAX_IMPORT_BYTES + 1)); c.close(); } }, { highWaterMark: 0 });
  const response = await worker.fetch(new Request("http://example.com/api/import", {
    method: "POST", body, headers: { cookie: athlete.cookie, origin: "http://example.com", "content-type": "application/json", ...(length ? { "content-length": length } : {}) },
  }), env, createExecutionContext());
  expect(response.status).toBe(413);
  if (length === String(MAX_IMPORT_BYTES + 1)) expect(pulls).toBe(0);
  expect((await exported(athlete)).data).toEqual(before.data);
});

it("rejects oversized generated batches and SQL/value/bind budgets before destructive writes", async () => {
  const { athlete } = await bootstrapTeam();
  await uploadFile("/api/plan/sessions/files", athlete);
  const data = emptyData();
  data.trainingSessions = Array.from({ length: 1500 }, (_, i) => ({ ...validData().trainingSessions[0], id: i + 1, notes: "x".repeat(3000) }));
  const response = await replace(athlete, data);
  expect(response.status).toBe(413);
  expect((await response.json() as { error: string }).error).toContain("batch budget");
  expect((await env.ATTACHMENTS.list()).objects).toHaveLength(1);
  expect((await env.DB.prepare("SELECT * FROM blob_cleanup").all()).results).toEqual([]);
  for (const statement of [{ sql: "x".repeat(100001), params: [] }, { sql: "SELECT ?", params: ["x".repeat(128001)] }, { sql: "SELECT ?", params: Array(101).fill(1) }]) {
    expect(() => preflightImport([statement])).toThrow();
  }
});

it.each(["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-01"])("rejects %s on normal writes and today queries", async date => {
  const { athlete } = await bootstrapTeam();
  expect((await api("/api/sessions", { cookie: athlete.cookie, json: { ...validData().trainingSessions[0], sessionDate: date } })).status).toBe(400);
  expect((await api("/api/scores", { cookie: athlete.cookie, json: { scoreDate: date, ends: Array(10).fill([8, 8, 8]) } })).status).toBe(400);
  expect((await api(`/api/tracker?today=${date}`, { cookie: athlete.cookie })).status).toBe(400);
});
