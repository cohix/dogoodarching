/**
 * Work item 0001 section 8 (A8): the unused `entries` table is gone from
 * export and import. Export omits `entries`; import accepts an `entries` key
 * from an old export file and ignores it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiJson, type Session } from "./helpers";
import {
  addItem, addScore, addSession, addSetup, checkItem, count, fileBody, parseContentDisposition, post, rows, setupAthletes, tracker,
} from "./tracker-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

const DATA_KEYS = [
  "bowSetups", "cycleWeekPlans", "inspirationEntries", "maintenanceChecks", "maintenanceItems", "milestoneChecks",
  "plannedSessionAttachments", "plannedSessionOverrides", "practiceScoreEnds", "practiceScores", "programState",
  "trainingSessions", "weeklyNotes",
];

type Row = Record<string, unknown>;

interface ExportFile {
  version: number;
  exportedAt: string;
  username: string;
  data: Record<string, unknown> & {
    trainingSessions: Row[]; practiceScores: Row[]; practiceScoreEnds: Row[]; programState: Row | null;
    cycleWeekPlans: Row[]; plannedSessionOverrides: Row[]; plannedSessionAttachments: Row[]; milestoneChecks: Row[];
    maintenanceChecks: Row[]; maintenanceItems: Row[]; inspirationEntries: Row[]; weeklyNotes: Row[]; bowSetups: Row[];
  };
}

interface ImportResult { ok: true; counts: Record<string, number> }

async function exportFor(session: Session): Promise<ExportFile> {
  const { status, body } = await apiJson<ExportFile>("/api/export", { cookie: session.cookie });
  if (status !== 200) throw new Error(`export failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

const importFor = (session: Session, file: unknown) => apiJson<ImportResult>("/api/import", { json: file, cookie: session.cookie });

/** One row in every exported collection, all small enough for a single import. */
async function fillAccount(session: Session): Promise<void> {
  await addSession(session, { sessionDate: "2026-09-14", notes: "first", arrows: 48 });
  await addSession(session, { sessionDate: "2026-09-15", sessionType: "Other", customActivity: "Yoga", arrows: 0, notes: "second" });
  await addScore(session, { scoreDate: "2026-09-15" });
  await post(session, "/api/plan/poundage", { poundage: 26 });
  await post(session, "/api/plan/weeks", { weekNumber: 2, primaryFocus: "Anchor", backgroundFocusOne: "Breathing", backgroundFocusTwo: "" });
  await post(session, "/api/plan/sessions", { dayKey: "tue", sessionType: "Range", detail: "Blank boss", prescription: "Shoot without a target face." });
  await post(session, "/api/plan/sessions/links", { dayKey: "tue", label: "Drill video", url: "https://example.org/drill" });
  await post(session, "/api/checks", { group: "milestone", key: "first-30m", checked: true });
  const item = await addItem(session, "Weekly", "Wax the string");
  await addItem(session, "Monthly", "Check limb bolts");
  await checkItem(session, item, true);
  await post(session, "/api/inspiration", {
    thoughtText: "Trust the shot", videoTitle: "Form check", videoUrl: "https://example.org/form", recipeName: "Oats",
    recipeSummary: "Breakfast", recipeIngredients: "Oats, milk", recipeInstructions: "Soak overnight",
  });
  await post(session, "/api/notes/weekly", { today: "2026-09-15", notes: "Good week" });
  await addSetup(session);
}

/** A version-1 export as written before `entries` was removed. */
function legacyFile(entries: unknown): Record<string, unknown> {
  const at = "2026-06-01T08:00:00.000Z";
  return {
    version: 1,
    exportedAt: "2026-06-02T09:30:00.000Z",
    username: "archer",
    data: {
      entries,
      trainingSessions: [
        { id: 11, sessionDate: "2026-05-30", sessionType: "Range", customActivity: "", arrows: 90, durationMinutes: 60, focus: "Release", score: "", notes: "legacy one", createdAt: at },
        { id: 12, sessionDate: "2026-05-31", sessionType: "Gym", customActivity: "", arrows: 0, durationMinutes: 40, focus: "", score: "", notes: "legacy two", createdAt: at },
      ],
      practiceScores: [{ id: 4, scoreDate: "2026-05-31", total: 240, createdAt: at }],
      practiceScoreEnds: Array.from({ length: 10 }, (_unused, index) => ({ id: 40 + index, scoreId: 4, endNumber: index + 1, arrow1: 8, arrow2: 8, arrow3: 8, endTotal: 24 })),
      programState: { currentPoundage: 24, currentCycle: 2, currentWeek: 6, updatedAt: at },
      cycleWeekPlans: [{ weekNumber: 1, primaryFocus: "Posture", backgroundFocusOne: "", backgroundFocusTwo: "", updatedAt: at }],
      plannedSessionOverrides: [{ dayKey: "wed", sessionType: "SPT", detail: "Band workout", prescription: "Legacy prescription", updatedAt: at }],
      plannedSessionAttachments: [{ id: 3, dayKey: "wed", kind: "link", label: "Band video", url: "https://example.org/band", mimeType: "text/uri-list", createdAt: at }],
      milestoneChecks: [{ key: "24lb", checked: true, updatedAt: at }],
      maintenanceChecks: [{ key: "item:7", checked: true, updatedAt: at }],
      maintenanceItems: [{ id: 7, section: "Weekly", label: "Wax the string", sortOrder: 0, createdAt: at, updatedAt: at }],
      inspirationEntries: [],
      weeklyNotes: [{ id: 2, weekStart: "2026-05-25", notes: "Legacy note", createdAt: at, updatedAt: at }],
      bowSetups: [],
    },
  };
}

const LEGACY_ENTRIES = [
  { id: 1, text: "First journal entry", createdAt: "2026-05-01T10:00:00.000Z" },
  { id: 2, text: "Second journal entry", createdAt: "2026-05-02T10:00:00.000Z" },
];

/** Export data with database ids replaced by positions, so two accounts can be compared. */
function withoutIds(file: ExportFile): unknown {
  const data = file.data;
  const scoreIndex = new Map(data.practiceScores.map((score, index) => [score.id, index]));
  const itemIndex = new Map(data.maintenanceItems.map((item, index) => [String(item.id), index]));
  const strip = (list: Row[]) => list.map(({ id: _id, ...rest }) => rest);
  return {
    ...data,
    trainingSessions: strip(data.trainingSessions),
    practiceScores: strip(data.practiceScores),
    practiceScoreEnds: data.practiceScoreEnds.map(({ id: _id, scoreId, ...rest }) => ({ ...rest, score: scoreIndex.get(scoreId) })),
    plannedSessionAttachments: strip(data.plannedSessionAttachments),
    maintenanceItems: strip(data.maintenanceItems),
    maintenanceChecks: data.maintenanceChecks.map((check) => {
      const match = /^item:(\d+)$/.exec(String(check.key));
      return match ? { ...check, key: `item#${itemIndex.get(match[1] as string)}` } : check;
    }).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    inspirationEntries: strip(data.inspirationEntries),
    weeklyNotes: strip(data.weeklyNotes),
    bowSetups: strip(data.bowSetups),
  };
}

describe("export omits entries", () => {
  it("a populated account exports exactly the thirteen collections, without entries", async () => {
    const { athlete } = await setupAthletes();
    await fillAccount(athlete);

    const file = await exportFor(athlete);

    expect(file.version).toBe(1);
    expect(file.username).toBe("archer");
    expect(Number.isNaN(Date.parse(file.exportedAt))).toBe(false);
    expect(Object.keys(file).sort()).toEqual(["data", "exportedAt", "username", "version"]);
    expect(Object.keys(file.data).sort()).toEqual(DATA_KEYS);
    expect(file.data).not.toHaveProperty("entries");
    expect(JSON.stringify(file)).not.toContain("\"entries\"");
    expect(file.data.trainingSessions).toHaveLength(2);
    expect(file.data.practiceScoreEnds).toHaveLength(10);
    expect(file.data.programState).toMatchObject({ currentPoundage: 26, currentCycle: 1, currentWeek: 1 });
  });

  it("a new account exports empty collections, no program state and no entries", async () => {
    const { athlete } = await setupAthletes();

    const file = await exportFor(athlete);

    expect(Object.keys(file.data).sort()).toEqual(DATA_KEYS);
    expect(file.data.programState).toBeNull();
    for (const key of DATA_KEYS.filter((name) => name !== "programState")) expect(file.data[key], key).toEqual([]);
  });

  it("coaches can export their own account, also without entries", async () => {
    const { owner } = await setupAthletes();
    const file = await exportFor(owner);
    expect(file.username).toBe("owner");
    expect(Object.keys(file.data).sort()).toEqual(DATA_KEYS);
  });

  it("the schema has no entries table left to export", async () => {
    expect(await rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'")).toEqual([]);
  });

  it("is sent as a JSON download named after the export date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
    const { athlete } = await setupAthletes();

    const response = await api("/api/export", { cookie: athlete.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const disposition = parseContentDisposition(response.headers.get("content-disposition"));
    expect(disposition.fallback).toBe("dga-export-20261231.json");
    expect(disposition.decoded).toBe("dga-export-20261231.json");
    await response.text();
  });

  it("contains only the caller's rows", async () => {
    const { athlete, rival } = await setupAthletes();
    await addSession(athlete, { notes: "mine" });
    await addSession(rival, { notes: "theirs" });
    await addScore(rival);

    const file = await exportFor(athlete);

    expect(file.data.trainingSessions.map((row) => row.notes)).toEqual(["mine"]);
    expect(file.data.practiceScores).toEqual([]);
    expect(file.data.practiceScoreEnds).toEqual([]);
  });

  it("excludes uploaded files and keeps links", async () => {
    const { athlete } = await setupAthletes();
    await post(athlete, "/api/plan/sessions/files", fileBody());
    await post(athlete, "/api/plan/sessions/links", { dayKey: "wed", label: "Video", url: "https://example.org/v" });

    const file = await exportFor(athlete);

    expect(file.data.plannedSessionAttachments.map((row) => [row.kind, row.label])).toEqual([["link", "Video"]]);
  });

  it("requires a session", async () => {
    expect((await api("/api/export")).status).toBe(401);
  });
});

describe("import accepts and ignores entries from an old export file", () => {
  it("imports the rest of a legacy file and reports no entries count", async () => {
    const { athlete } = await setupAthletes();

    const result = await importFor(athlete, legacyFile(LEGACY_ENTRIES));

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.counts).not.toHaveProperty("entries");
    expect(Object.keys(result.body.counts).sort()).toEqual(DATA_KEYS);
    expect(result.body.counts).toMatchObject({ trainingSessions: 2, practiceScores: 1, practiceScoreEnds: 10, programState: 1, maintenanceItems: 1, weeklyNotes: 1 });
    // The legacy data is usable straight away.
    const payload = await tracker(athlete, { today: "2026-06-01" });
    expect(payload.sessions.map((session) => session.notes)).toEqual(["legacy two", "legacy one"]);
    expect(payload.practiceScores).toHaveLength(1);
    expect(payload.practiceScores[0]?.ends).toHaveLength(10);
    expect(payload.state).toEqual({ currentPoundage: 24, currentCycle: 2, currentWeek: 6 });
    expect(payload.plannedSessions.find((day) => day.dayKey === "wed")).toMatchObject({ sessionType: "SPT", detail: "Band workout" });
    expect(payload.maintenanceItems).toMatchObject([{ label: "Wax the string", checked: true }]);
  });

  it("stores the entries nowhere and never exports them again", async () => {
    const { athlete } = await setupAthletes();
    expect((await importFor(athlete, legacyFile(LEGACY_ENTRIES))).status).toBe(200);

    const file = await exportFor(athlete);

    expect(file.data).not.toHaveProperty("entries");
    const stored = JSON.stringify(file) + JSON.stringify(await tracker(athlete, { today: "2026-06-01" }));
    expect(stored).not.toContain("journal entry");
    expect(await rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'")).toEqual([]);
  });

  it("gives the same result with and without the entries key", async () => {
    const { athlete, rival } = await setupAthletes();
    const { entries: _entries, ...dataWithout } = legacyFile(LEGACY_ENTRIES).data as Record<string, unknown>;

    const withKey = await importFor(athlete, legacyFile(LEGACY_ENTRIES));
    const withoutKey = await importFor(rival, { ...legacyFile([]), data: dataWithout });

    expect(withKey.status).toBe(200);
    expect(withoutKey.status).toBe(200);
    expect(withKey.body.counts).toEqual(withoutKey.body.counts);
    expect(withoutIds(await exportFor(athlete))).toEqual(withoutIds(await exportFor(rival)));
  });

  it.each([
    ["an empty list", []],
    ["rows in an unknown shape", [{ anything: true }, 42, "text", null]],
    ["null", null],
    ["a string", "legacy"],
    ["an object", { id: 1, text: "x" }],
    ["a large list", Array.from({ length: 2000 }, (_unused, index) => ({ id: index + 1, text: `entry ${index}`, createdAt: "2026-05-01T10:00:00.000Z" }))],
  ])("ignores entries given as %s", async (_label, entries) => {
    const { athlete } = await setupAthletes();

    const result = await importFor(athlete, legacyFile(entries));

    expect(result.status).toBe(200);
    expect(result.body.counts).not.toHaveProperty("entries");
    expect(await count("training_sessions", "user_id = ?", athlete.user.id)).toBe(2);
  });

  it("still validates the rest of the file when entries is present", async () => {
    const { athlete } = await setupAthletes();
    await addSession(athlete, { notes: "keep me" });
    const broken = legacyFile(LEGACY_ENTRIES);
    (broken.data as Record<string, unknown>).trainingSessions = [{ id: 1, sessionDate: "2026-05-30" }];

    const result = await apiJson("/api/import", { json: broken, cookie: athlete.cookie });

    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error");
    expect((await rows<{ notes: string }>("SELECT notes FROM training_sessions")).map((row) => row.notes)).toEqual(["keep me"]);
  });
});

describe("export → import round trip", () => {
  it("restores a small account exactly (ids aside)", async () => {
    const { athlete } = await setupAthletes();
    await fillAccount(athlete);
    const before = await exportFor(athlete);
    const dashboardBefore = await tracker(athlete, { today: "2026-09-16" });

    const result = await importFor(athlete, before);

    expect(result.status).toBe(200);
    const after = await exportFor(athlete);
    expect(withoutIds(after)).toEqual(withoutIds(before));
    const dashboardAfter = await tracker(athlete, { today: "2026-09-16" });
    expect(dashboardAfter.state).toEqual(dashboardBefore.state);
    expect(dashboardAfter.sessions.map((session) => session.notes)).toEqual(dashboardBefore.sessions.map((session) => session.notes));
    expect(dashboardAfter.practiceScores.map((score) => score.ends)).toEqual(dashboardBefore.practiceScores.map((score) => score.ends));
    expect(dashboardAfter.maintenanceItems.map(({ label, checked }) => ({ label, checked }))).toEqual(dashboardBefore.maintenanceItems.map(({ label, checked }) => ({ label, checked })));
    // Import replaces; it does not append.
    expect(await count("training_sessions", "user_id = ?", athlete.user.id)).toBe(2);
    expect(await count("practice_score_ends", "user_id = ?", athlete.user.id)).toBe(10);
  });

  it("moves an account's data to another account without touching anyone else", async () => {
    const { owner, athlete, rival } = await setupAthletes();
    await fillAccount(athlete);
    await addSession(rival, { notes: "rival before import" });
    await addSession(owner, { notes: "owner row" });
    const source = await exportFor(athlete);
    const ownerBefore = await exportFor(owner);

    const result = await importFor(rival, source);

    expect(result.status).toBe(200);
    expect(withoutIds(await exportFor(rival))).toEqual(withoutIds(source));
    // The source account and the bystander are unchanged, ids included.
    expect((await exportFor(athlete)).data).toEqual(source.data);
    expect((await exportFor(owner)).data).toEqual(ownerBefore.data);
    // No id of the imported copy collides with the source rows.
    expect(await count("training_sessions")).toBe(2 + 2 + 1);
    expect(await count("training_sessions", "notes = 'rival before import'")).toBe(0);
  });

  it("restores an account with twelve sessions and two scores", async () => {
    const { athlete } = await setupAthletes();
    for (let index = 0; index < 12; index++) await addSession(athlete, { sessionDate: `2026-09-${String(index + 1).padStart(2, "0")}`, notes: `session ${index}` });
    await addScore(athlete, { scoreDate: "2026-09-05" });
    await addScore(athlete, { scoreDate: "2026-09-12" });
    const before = await exportFor(athlete);

    const result = await importFor(athlete, before);

    expect(result.status).toBe(200);
    expect(result.body.counts).toMatchObject({ trainingSessions: 12, practiceScores: 2, practiceScoreEnds: 20 });
    expect(withoutIds(await exportFor(athlete))).toEqual(withoutIds(before));
  });

  it("an old export file with entries and a realistic history imports", async () => {
    const { athlete } = await setupAthletes();
    const file = legacyFile(LEGACY_ENTRIES);
    (file.data as Record<string, unknown>).trainingSessions = Array.from({ length: 40 }, (_unused, index) => ({
      id: index + 1, sessionDate: `2026-05-${String((index % 28) + 1).padStart(2, "0")}`, sessionType: "Range", customActivity: "", arrows: 60,
      durationMinutes: 45, focus: "", score: "", notes: `legacy ${index}`, createdAt: "2026-06-01T08:00:00.000Z",
    }));

    const result = await importFor(athlete, file);

    expect(result.status).toBe(200);
    expect(result.body.counts).toMatchObject({ trainingSessions: 40 });
    expect(await count("training_sessions", "user_id = ?", athlete.user.id)).toBe(40);
  });
});

describe("import validation", () => {
  it.each([
    ["an unknown version", { ...legacyFile([]), version: 2 }],
    ["no data", { version: 1 }],
    ["a missing collection", { version: 1, data: { entries: [] } }],
    ["an array", [legacyFile([])]],
  ])("rejects %s with 400 and keeps existing data", async (_label, body) => {
    const { athlete } = await setupAthletes();
    await addSession(athlete, { notes: "keep me" });

    const result = await apiJson("/api/import", { json: body, cookie: athlete.cookie });

    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error");
    expect(await count("training_sessions", "notes = 'keep me'")).toBe(1);
  });

  it("requires a session", async () => {
    expect((await api("/api/import", { json: legacyFile([]) })).status).toBe(401);
    expect(await count("training_sessions")).toBe(0);
  });
});

it("round-trips multiple D1 chunks of every unbounded collection, including wide setups and score ends", async () => {
  const { athlete } = await setupAthletes();
  await fillAccount(athlete);
  const file = await exportFor(athlete);
  const data = file.data;
  const expand = (source: Row[], length: number, fields: (index: number) => Row = () => ({})) =>
    Array.from({ length }, (_, index) => ({ ...source[0], ...("id" in source[0]! ? { id: index + 1 } : {}), ...fields(index) }));
  data.trainingSessions = expand(data.trainingSessions, 40);
  data.practiceScores = expand(data.practiceScores, 30);
  const ends = data.practiceScoreEnds;
  data.practiceScoreEnds = data.practiceScores.flatMap((score, index) => ends.map((end, n) => ({ ...end, id: index * 10 + n + 1, scoreId: score.id })));
  data.plannedSessionAttachments = expand(data.plannedSessionAttachments, 30);
  data.maintenanceItems = expand(data.maintenanceItems, 30, index => ({ sortOrder: index, label: `Item ${index}` }));
  data.maintenanceChecks = expand(data.maintenanceChecks, 30, index => ({ key: `item:${index + 1}` }));
  data.milestoneChecks = expand(data.milestoneChecks, 30, index => ({ key: `milestone-${index}` }));
  data.inspirationEntries = expand(data.inspirationEntries, 30);
  data.weeklyNotes = expand(data.weeklyNotes, 30, index => ({ weekStart: new Date(Date.UTC(2026, 0, 5 + index * 7)).toISOString().slice(0, 10) }));
  data.bowSetups = expand(data.bowSetups, 30);
  const result = await importFor(athlete, file);
  expect(result.status).toBe(200);
  expect(result.body.counts).toMatchObject({ trainingSessions: 40, practiceScores: 30, practiceScoreEnds: 300, bowSetups: 30 });
  expect(withoutIds(await exportFor(athlete))).toEqual(withoutIds(file));
});

it("rolls back earlier import chunks and deletes when a later chunk violates uniqueness", async () => {
  const { athlete } = await setupAthletes();
  await fillAccount(athlete);
  const before = await exportFor(athlete);
  const file = structuredClone(before);
  file.data.trainingSessions = Array.from({ length: 40 }, (_, index) => ({ ...before.data.trainingSessions[0], id: index + 1, notes: "replacement" }));
  file.data.bowSetups = Array.from({ length: 30 }, (_, index) => ({ ...before.data.bowSetups[0], id: index + 1 }));
  // The final collection's duplicate natural key fails after the wide inserts.
  file.data.weeklyNotes = [...file.data.weeklyNotes, ...file.data.weeklyNotes];
  const result = await importFor(athlete, file);
  expect(result.status).toBe(500);
  expect(withoutIds(await exportFor(athlete))).toEqual(withoutIds(before));
});
