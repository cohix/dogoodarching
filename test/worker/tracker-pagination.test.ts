/**
 * Work item 0001 section 5 (A5): session history is capped at 100 rows per
 * page and continues with `?before=<sessionDate>,<id>`. Pages must return every
 * session exactly once, in a stable order, including sessions on the same
 * date (ordered by id) and ids that do not follow date order.
 */
import { describe, expect, it } from "vitest";
import { api, apiJson, type Session } from "./helpers";
import { addScore, addSession, dayPlus, rows, seedSessionRows, seedSessions, setupAthletes, tracker, trackerPath, type SeedSession, type TrackerSession } from "./tracker-fixtures";

const TODAY = "2026-09-28";
const PAGE = 100;

const cursorOf = (session: Pick<TrackerSession, "sessionDate" | "id">) => `${session.sessionDate},${session.id}`;

/** Follows the cursor until a page comes back empty. */
async function walk(session: Session, maxPages = 12): Promise<TrackerSession[][]> {
  const pages: TrackerSession[][] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const payload = await tracker(session, { today: TODAY, before });
    pages.push(payload.sessions);
    const last = payload.sessions.at(-1);
    if (!last) return pages;
    before = cursorOf(last);
  }
  throw new Error(`paging did not terminate within ${maxPages} pages`);
}

/** The order the API promises: newest date first, then highest id first. */
const expectedOrder = (userId: string) =>
  rows<{ id: number; session_date: string }>("SELECT id, session_date FROM training_sessions WHERE user_id = ? ORDER BY session_date DESC, id DESC", userId);

/**
 * 250 sessions for the athlete, interleaved row by row with 250 of the rival's:
 * - 120 on one date (the page-1 boundary falls inside that group),
 * - 30 on the following date,
 * - 100 on older dates in a scrambled order, so a higher id is often an older date.
 */
async function seedHistory(athleteId: string, rivalId: string): Promise<void> {
  const sessions: SeedSession[] = [
    ...Array.from({ length: 100 }, (_unused, index) => ({ sessionDate: dayPlus("2026-05-01", (index * 37) % 60), notes: `old ${index}` })),
    ...Array.from({ length: 120 }, (_unused, index) => ({ sessionDate: "2026-09-20", notes: `same ${index}` })),
    ...Array.from({ length: 30 }, (_unused, index) => ({ sessionDate: "2026-09-21", notes: `next ${index}` })),
  ];
  // Scramble deterministically: 250 and 7 are coprime, so this is a permutation.
  const scrambled = sessions.map((_session, index) => sessions[(index * 7) % sessions.length] as SeedSession);
  await seedSessionRows(scrambled.flatMap((session) => [
    { ...session, userId: athleteId },
    { ...session, userId: rivalId, notes: `rival ${session.notes}` },
  ]));
}

describe("session history pagination", () => {
  it("returns every session exactly once across pages, newest first, ties broken by id", async () => {
    const { athlete, rival } = await setupAthletes();
    await seedHistory(athlete.user.id, rival.user.id);
    const expected = await expectedOrder(athlete.user.id);
    expect(expected).toHaveLength(250);

    const pages = await walk(athlete);

    expect(pages.map((page) => page.length)).toEqual([PAGE, PAGE, 50, 0]);
    const all = pages.flat();
    expect(new Set(all.map((session) => session.id)).size).toBe(all.length);
    expect(all.map((session) => [session.id, session.sessionDate])).toEqual(expected.map((row) => [row.id, row.session_date]));
    // The page boundary really does split the same-date group.
    expect(pages[0]?.at(-1)?.sessionDate).toBe("2026-09-20");
    expect(pages[1]?.[0]?.sessionDate).toBe("2026-09-20");
    // Ids are not in date order in this data set, so date order is not an accident of insertion order.
    expect(all.map((session) => session.id)).not.toEqual([...all.map((session) => session.id)].sort((a, b) => b - a));
    // No row of the rival's interleaved history leaks in.
    expect(all.every((session) => !session.notes.startsWith("rival"))).toBe(true);
  });

  it("is stable: walking the history twice gives the identical sequence", async () => {
    const { athlete, rival } = await setupAthletes();
    await seedHistory(athlete.user.id, rival.user.id);

    const first = (await walk(athlete)).flat().map((session) => session.id);
    const second = (await walk(athlete)).flat().map((session) => session.id);

    expect(second).toEqual(first);
  });

  it("pages each athlete's own history independently", async () => {
    const { athlete, rival } = await setupAthletes();
    await seedHistory(athlete.user.id, rival.user.id);

    const theirs = (await walk(rival)).flat();

    expect(theirs.map((session) => session.id)).toEqual((await expectedOrder(rival.user.id)).map((row) => row.id));
    expect(theirs.every((session) => session.notes.startsWith("rival"))).toBe(true);
  });

  it("when every session shares one date, order is id descending and nothing repeats", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 230 }, () => ({ sessionDate: "2026-09-20" })));

    const pages = await walk(athlete);

    expect(pages.map((page) => page.length)).toEqual([PAGE, PAGE, 30, 0]);
    const ids = pages.flat().map((session) => session.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(230);
  });

  it("a history of exactly 200 sessions ends with an empty third page", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 200 }, (_unused, index) => ({ sessionDate: dayPlus("2026-01-01", index % 50) })));

    const pages = await walk(athlete);

    expect(pages.map((page) => page.length)).toEqual([PAGE, PAGE, 0]);
    expect(new Set(pages.flat().map((session) => session.id)).size).toBe(200);
  });

  it("fewer than 100 sessions fit on the first page", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 99 }, (_unused, index) => ({ sessionDate: dayPlus("2026-01-01", index % 9) })));

    const pages = await walk(athlete);

    expect(pages.map((page) => page.length)).toEqual([99, 0]);
  });

  it("the cursor is exclusive, continues within the same date and ignores id order across dates", async () => {
    const { athlete } = await setupAthletes();
    const older = await addSession(athlete, { sessionDate: "2026-09-10", notes: "older date, lowest id" });
    const sameLow = await addSession(athlete, { sessionDate: "2026-09-15", notes: "same date, lower id" });
    const boundary = await addSession(athlete, { sessionDate: "2026-09-15", notes: "boundary" });
    const sameHigh = await addSession(athlete, { sessionDate: "2026-09-15", notes: "same date, higher id" });
    const newer = await addSession(athlete, { sessionDate: "2026-09-16", notes: "newer date" });
    const olderHighId = await addSession(athlete, { sessionDate: "2026-09-01", notes: "older date, highest id" });

    const first = await tracker(athlete, { today: TODAY });
    expect(first.sessions.map((session) => session.id)).toEqual([newer, sameHigh, boundary, sameLow, older, olderHighId]);

    const after = await tracker(athlete, { today: TODAY, before: `2026-09-15,${boundary}` });
    expect(after.sessions.map((session) => session.id)).toEqual([sameLow, older, olderHighId]);
  });

  it("a cursor whose row was deleted in the meantime still continues from the same place", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 150 }, (_unused, index) => ({ sessionDate: dayPlus("2026-03-01", index % 30) })));
    const first = await tracker(athlete, { today: TODAY });
    const last = first.sessions.at(-1) as TrackerSession;
    const expectedRest = (await expectedOrder(athlete.user.id)).slice(PAGE).map((row) => row.id);

    expect((await api(`/api/sessions/${last.id}`, { method: "DELETE", cookie: athlete.cookie })).status).toBe(200);
    const second = await tracker(athlete, { today: TODAY, before: cursorOf(last) });

    expect(second.sessions.map((session) => session.id)).toEqual(expectedRest);
  });

  it("a session logged while paging does not repeat or drop older rows", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 150 }, (_unused, index) => ({ sessionDate: dayPlus("2026-03-01", index % 30) })));
    const expected = (await expectedOrder(athlete.user.id)).map((row) => row.id);
    const first = await tracker(athlete, { today: TODAY });

    await addSession(athlete, { sessionDate: "2026-09-27", notes: "logged mid-walk" });
    const second = await tracker(athlete, { today: TODAY, before: cursorOf(first.sessions.at(-1) as TrackerSession) });

    expect([...first.sessions, ...second.sessions].map((session) => session.id)).toEqual(expected);
  });

  it("a cursor built from another athlete's session is only a position, never a way in", async () => {
    const { athlete, rival } = await setupAthletes();
    const mine = await addSession(athlete, { sessionDate: "2026-09-10" });
    const theirs = await addSession(rival, { sessionDate: "2026-09-12", notes: "private" });

    const page = await tracker(athlete, { today: TODAY, before: `2026-09-12,${theirs}` });

    expect(page.sessions.map((session) => session.id)).toEqual([mine]);
  });

  it("a cursor older than the whole history returns an empty page", async () => {
    const { athlete } = await setupAthletes();
    await addSession(athlete, { sessionDate: "2026-09-10" });

    expect((await tracker(athlete, { today: TODAY, before: "2000-01-01,1" })).sessions).toEqual([]);
  });

  it("paging affects only sessions: scores and aggregates are the same on every page", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 130 }, (_unused, index) => ({ sessionDate: dayPlus(TODAY, index % 7), arrows: 10 + (index % 5) })));
    await addScore(athlete);
    const first = await tracker(athlete, { today: TODAY });
    const second = await tracker(athlete, { today: TODAY, before: cursorOf(first.sessions.at(-1) as TrackerSession) });

    expect(second.sessions).toHaveLength(30);
    for (const key of ["state", "plannedSessions", "practiceScores", "weeklyArrows", "cycleSummaries", "maintenanceItems", "setups"]) {
      expect(second[key], key).toEqual(first[key]);
    }
    // Aggregates cover all 130 sessions of the current week, not just the 100 on the page.
    const total = Array.from({ length: 130 }, (_unused, index) => 10 + (index % 5)).reduce((sum, value) => sum + value, 0);
    expect(first.weeklyArrows.reduce((sum, week) => sum + week.arrows, 0)).toBe(total);
  });

  it("session rows keep their full shape on later pages", async () => {
    const { athlete } = await setupAthletes();
    await seedSessions(athlete.user.id, Array.from({ length: 101 }, (_unused, index) => ({ sessionDate: dayPlus("2026-03-01", index), focus: `focus ${index}`, notes: `notes ${index}` })));
    const first = await tracker(athlete, { today: TODAY });

    const second = await tracker(athlete, { today: TODAY, before: cursorOf(first.sessions.at(-1) as TrackerSession) });

    expect(second.sessions).toHaveLength(1);
    expect(Object.keys(second.sessions[0] as TrackerSession).sort()).toEqual(Object.keys(first.sessions[0] as TrackerSession).sort());
    expect(second.sessions[0]).toMatchObject({ sessionDate: "2026-03-01", focus: "focus 0", notes: "notes 0", sessionType: "Range", arrows: 30 });
  });
});

describe("invalid before cursors", () => {
  it.each([
    ["empty", ""],
    ["date only", "2026-09-15"],
    ["id only", "12"],
    ["reversed", "12,2026-09-15"],
    ["zero id", "2026-09-15,0"],
    ["negative id", "2026-09-15,-4"],
    ["leading-zero id", "2026-09-15,007"],
    ["fractional id", "2026-09-15,1.5"],
    ["exponent id", "2026-09-15,1e3"],
    ["id beyond the safe integer range", "2026-09-15,99999999999999999999"],
    ["impossible month", "2026-13-01,5"],
    ["impossible day", "2026-02-30,5"],
    ["non-leap 29 February", "2025-02-29,5"],
    ["short year", "26-09-15,5"],
    ["date-time", "2026-09-15T10:00:00Z,5"],
    ["extra field", "2026-09-15,5,6"],
    ["trailing space", "2026-09-15,5 "],
    ["SQL fragment", "2026-09-15,5 OR 1=1"],
    ["quote", "2026-09-15',5"],
  ])("%s → 400 { error: 'Invalid before parameter' }", async (_label, before) => {
    const { athlete } = await setupAthletes();
    await addSession(athlete);

    const response = await apiJson(`/api/tracker?today=${TODAY}&before=${encodeURIComponent(before)}`, { cookie: athlete.cookie });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid before parameter" });
  });

  it("a valid leap-day cursor is accepted", async () => {
    const { athlete } = await setupAthletes();
    const id = await addSession(athlete, { sessionDate: "2024-02-28" });

    const response = await apiJson<{ sessions: TrackerSession[] }>(trackerPath({ today: TODAY, before: "2024-02-29,1" }), { cookie: athlete.cookie });

    expect(response.status).toBe(200);
    expect(response.body.sessions.map((session) => session.id)).toEqual([id]);
  });

  it("an invalid today is still reported as such", async () => {
    const { athlete } = await setupAthletes();
    const response = await apiJson("/api/tracker?today=28-09-2026&before=2026-09-15,5", { cookie: athlete.cookie });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid today parameter" });
  });

  it("paging requires a session", async () => {
    expect((await api("/api/tracker?before=2026-09-15,5")).status).toBe(401);
  });
});
