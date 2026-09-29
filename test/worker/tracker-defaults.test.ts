/**
 * Work item 0001 section 8 (A8): a new athlete starts at cycle 1 / week 1 with
 * no poundage and the generic starter plan; the tracker payload reports the
 * poundage as not set (`currentPoundage === null`) and saving one persists it.
 *
 * The clock is pinned (Date only) so week arithmetic is deterministic. The
 * Worker runs in the same isolate as the test, so it sees the same clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROGRAM_STATE, plannedSessionDefaults } from "../../src/services/plan";
import { api, apiJson, type Session } from "./helpers";
import { count, dayPlus, rows, setupAthletes as realSetupAthletes, setupSquad as realSetupSquad, tracker, type Tracker } from "./tracker-fixtures";

// Wednesday 2026-09-23, mid-morning UTC: the UTC date and the dates used as
// `today` below fall in the same ISO week (Monday 2026-09-21).
const NOW = "2026-09-23T10:00:00Z";
const TODAY = "2026-09-23";
const MONDAY = "2026-09-21";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

// Account creation uses D1's real execution clock. Freeze only the program
// calendar under test; do not create already-expired invites in the past.
async function withCalendarClock<T>(setup: () => Promise<T>): Promise<T> {
  const calendarNow = new Date();
  vi.useRealTimers();
  const result = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(calendarNow);
  return result;
}
const setupAthletes = () => withCalendarClock(realSetupAthletes);
const setupSquad = () => withCalendarClock(realSetupSquad);

const NOT_SET = { currentPoundage: null, currentCycle: 1, currentWeek: 1 };

const STARTER_PLAN = [
  { dayKey: "mon", day: "Monday", short: "Mon", sessionType: "Practice", detail: "Technique practice", prescription: "Choose a focus for your practice." },
  { dayKey: "tue", day: "Tuesday", short: "Tue", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals." },
  { dayKey: "wed", day: "Wednesday", short: "Wed", sessionType: "Practice", detail: "Skills practice", prescription: "Choose a skill to work on." },
  { dayKey: "thu", day: "Thursday", short: "Thu", sessionType: "Review", detail: "Review your progress", prescription: "Reflect on your practice and update your plan." },
  { dayKey: "fri", day: "Friday", short: "Fri", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals." },
  { dayKey: "sat", day: "Saturday", short: "Sat", sessionType: "Practice", detail: "Open practice", prescription: "Plan a session around your current goals." },
  { dayKey: "sun", day: "Sunday", short: "Sun", sessionType: "Rest", detail: "Rest and reflect", prescription: "Take time to rest and plan the week ahead." },
];

const savePoundage = (session: Session, poundage: unknown, today?: string) =>
  apiJson<{ currentPoundage: number }>("/api/plan/poundage", { json: { poundage, today }, cookie: session.cookie });

const planOf = (payload: Pick<Tracker, "plannedSessions">) =>
  payload.plannedSessions.map(({ dayKey, day, short, sessionType, detail, prescription }) => ({ dayKey, day, short, sessionType, detail, prescription }));

describe("new athlete defaults", () => {
  it("the default is one constant: cycle 1, week 1, no poundage", () => {
    expect(DEFAULT_PROGRAM_STATE).toEqual(NOT_SET);
  });

  it("a new athlete gets cycle 1 / week 1 and the payload reports poundage as not set", async () => {
    const { athlete } = await setupAthletes();

    const payload = await tracker(athlete, { today: TODAY });

    expect(payload.state).toEqual(NOT_SET);
    expect(payload.state.currentPoundage).toBeNull();
    // `state` carries no fabricated number and no extra flag.
    expect(Object.keys(payload.state).sort()).toEqual(["currentCycle", "currentPoundage", "currentWeek"]);
    // Signing up and reading the dashboard stores nothing.
    expect(await count("program_state")).toBe(0);
  });

  it.each(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-26", "2026-09-27"])(
    "is week 1 on every day of the athlete's first week (today=%s)", async (today) => {
      const { athlete } = await setupAthletes();
      expect((await tracker(athlete, { today })).state).toEqual(NOT_SET);
    });

  it("uses the server date when the client sends no today", async () => {
    const { athlete } = await setupAthletes();
    expect((await tracker(athlete)).state).toEqual(NOT_SET);
  });

  it("a new athlete gets the starter plan: seven neutral days, none saved", async () => {
    const { athlete } = await setupAthletes();

    const payload = await tracker(athlete, { today: TODAY });

    expect(planOf(payload)).toEqual(STARTER_PLAN);
    for (const day of payload.plannedSessions) {
      expect(day.updatedAt, day.dayKey).toBeNull();
      expect(day.attachments, day.dayKey).toEqual([]);
    }
    expect(payload.weeklyPlans).toEqual([]);
    expect(await count("planned_session_overrides")).toBe(0);
  });

  it("the starter plan carries no personal prescriptions from the reference implementation", () => {
    expect(plannedSessionDefaults.map((day) => day.dayKey)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    for (const day of plannedSessionDefaults) {
      const text = `${day.sessionType} ${day.detail} ${day.prescription}`;
      // No numbers (arrow counts, poundages, durations, distances) and no named drills or gear.
      expect(text, day.dayKey).not.toMatch(/\d/);
      expect(text, day.dayKey).not.toMatch(/\b(lbs?|pounds?|poundage|arrows?|SPT|band|gym|reps?|sets?|minutes?|metres?|meters?|yards?)\b/i);
      expect(day.prescription.length, day.dayKey).toBeLessThanOrEqual(80);
      expect(day.detail.length, day.dayKey).toBeLessThanOrEqual(40);
    }
  });

  it("every other section of a new athlete's dashboard is empty", async () => {
    const { athlete } = await setupAthletes();

    const payload = await tracker(athlete, { today: TODAY });

    expect(payload.sessions).toEqual([]);
    expect(payload.practiceScores).toEqual([]);
    expect(payload.weeklyArrows).toEqual([]);
    expect(payload.maintenanceItems).toEqual([]);
    expect(payload.setups).toEqual([]);
    expect(payload.cycleSummaries).toHaveLength(1);
    expect(payload.cycleSummaries[0]?.cycle).toBe(1);
    expect(payload.cycleSummaries[0]?.weeks.map((week) => week.weekStart)).toEqual([0, 1, 2, 3, 4, 5].map((week) => dayPlus(MONDAY, week * 7)));
    expect(payload.cycleSummaries[0]?.weeks.every((week) => week.arrows === 0)).toBe(true);
  });

  it("coaches see the same defaults for a new athlete, and have no tracker of their own (0003 §5)", async () => {
    const { owner, coach, athlete } = await setupSquad();

    for (const viewer of [owner, coach]) {
      const overview = await apiJson<Pick<Tracker, "state" | "plannedSessions">>(`/api/coach/athletes/${athlete.user.id}/overview?today=${TODAY}`, { cookie: viewer.cookie });
      expect(overview.status).toBe(200);
      expect(overview.body.state).toEqual(NOT_SET);
      expect(planOf(overview.body)).toEqual(STARTER_PLAN);
    }
    for (const viewer of [owner, coach]) {
      expect((await api(`/api/tracker?today=${TODAY}`, { cookie: viewer.cookie })).status).toBe(403);
    }
    expect(await count("program_state")).toBe(0);
  });

  it("the program advances with the calendar once the first week is over", async () => {
    const { athlete } = await setupAthletes();
    // Anchor the program: saving the poundage writes the row at cycle 1 / week 1.
    expect((await savePoundage(athlete, 24)).status).toBe(200);

    const at = async (today: string) => (await tracker(athlete, { today })).state;

    expect(await at("2026-09-27")).toEqual({ currentPoundage: 24, currentCycle: 1, currentWeek: 1 });
    expect(await at("2026-09-28")).toEqual({ currentPoundage: 24, currentCycle: 1, currentWeek: 2 });
    expect(await at(dayPlus(MONDAY, 5 * 7 + 6))).toEqual({ currentPoundage: 24, currentCycle: 1, currentWeek: 6 });
    expect(await at(dayPlus(MONDAY, 6 * 7))).toEqual({ currentPoundage: 24, currentCycle: 2, currentWeek: 1 });
    // A client date before the anchor never goes below week 1.
    expect(await at("2026-08-01")).toEqual({ currentPoundage: 24, currentCycle: 1, currentWeek: 1 });
  });
});

describe("new athlete defaults across time zones", () => {
  // The athlete's calendar date (`today`) and the server's UTC date can fall in
  // different ISO weeks for a few hours around the Sunday/Monday boundary.

  it("an athlete whose local Sunday is still behind UTC Monday starts at week 1", async () => {
    vi.setSystemTime(new Date("2026-09-28T03:00:00Z")); // Monday 03:00 UTC = Sunday 20:00 in Los Angeles
    const { athlete } = await setupAthletes();

    expect((await tracker(athlete, { today: "2026-09-27" })).state).toEqual(NOT_SET);
  });

  it("an athlete whose local Monday is ahead of UTC Sunday starts at week 1", async () => {
    vi.setSystemTime(new Date("2026-09-27T20:00:00Z")); // Sunday 20:00 UTC = Monday 09:00 in Auckland
    const { athlete } = await setupAthletes();

    expect((await tracker(athlete, { today: "2026-09-28" })).state).toEqual(NOT_SET);
  });

  it("saving the poundage on a local Monday ahead of UTC keeps the athlete in week 1", async () => {
    vi.setSystemTime(new Date("2026-09-27T20:00:00Z"));
    const { athlete } = await setupAthletes();

    expect((await savePoundage(athlete, 24, "2026-09-28")).status).toBe(200);

    expect((await tracker(athlete, { today: "2026-09-28" })).state).toEqual({ currentPoundage: 24, currentCycle: 1, currentWeek: 1 });
  });
});

describe("saving a poundage", () => {
  it("persists it and the dashboard reports it from then on", async () => {
    const { athlete } = await setupAthletes();

    const saved = await savePoundage(athlete, 26);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ currentPoundage: 26 });
    expect(await rows("SELECT user_id, current_poundage, current_cycle, current_week FROM program_state")).toEqual([
      { user_id: athlete.user.id, current_poundage: 26, current_cycle: 1, current_week: 1 },
    ]);
    expect((await tracker(athlete, { today: TODAY })).state).toEqual({ currentPoundage: 26, currentCycle: 1, currentWeek: 1 });
    // Still there on the next read.
    expect((await tracker(athlete, { today: TODAY })).state.currentPoundage).toBe(26);
  });

  it("is visible to every coach through the overview", async () => {
    const { owner, coach, athlete } = await setupSquad();
    await savePoundage(athlete, 30);

    for (const viewer of [owner, coach]) {
      const overview = await apiJson<Pick<Tracker, "state">>(`/api/coach/athletes/${athlete.user.id}/overview?today=${TODAY}`, { cookie: viewer.cookie });
      expect(overview.body.state).toEqual({ currentPoundage: 30, currentCycle: 1, currentWeek: 1 });
    }
  });

  it("belongs to the caller only", async () => {
    const { athlete, rival } = await setupAthletes();

    await savePoundage(athlete, 28);

    expect((await tracker(rival, { today: TODAY })).state).toEqual(NOT_SET);
    expect(await count("program_state", "user_id = ?", rival.user.id)).toBe(0);
  });

  it("can be changed, keeping the cycle, week and anchor of an existing program", async () => {
    const { athlete } = await setupAthletes();
    await savePoundage(athlete, 24);
    // Move the program to week 3 through the schedule adjustment.
    for (let step = 0; step < 2; step++) {
      expect((await api("/api/plan/adjust", { json: { adjustment: "forward", today: TODAY }, cookie: athlete.cookie })).status).toBe(200);
    }
    const before = await rows("SELECT current_cycle, current_week, updated_at FROM program_state WHERE user_id = ?", athlete.user.id);
    vi.setSystemTime(new Date("2026-09-24T18:30:00Z"));

    const saved = await savePoundage(athlete, 28);

    expect(saved.body).toEqual({ currentPoundage: 28 });
    expect(await rows("SELECT current_cycle, current_week, updated_at FROM program_state WHERE user_id = ?", athlete.user.id)).toEqual(before);
    expect((await tracker(athlete, { today: "2026-09-24" })).state).toEqual({ currentPoundage: 28, currentCycle: 1, currentWeek: 3 });
    expect(await count("program_state")).toBe(1);
  });

  it.each([1, 100])("accepts the boundary value %i", async (poundage) => {
    const { athlete } = await setupAthletes();
    const saved = await savePoundage(athlete, poundage);
    expect(saved.status).toBe(200);
    expect((await tracker(athlete, { today: TODAY })).state.currentPoundage).toBe(poundage);
  });

  it.each([
    ["zero", { poundage: 0 }],
    ["negative", { poundage: -24 }],
    ["above 100", { poundage: 101 }],
    ["fractional", { poundage: 24.5 }],
    ["a string", { poundage: "24" }],
    ["null", { poundage: null }],
    ["missing", {}],
    ["an array body", [24]],
  ])("rejects %s with 400 and stores nothing", async (_label, body) => {
    const { athlete } = await setupAthletes();

    const response = await apiJson("/api/plan/poundage", { json: body, cookie: athlete.cookie });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(await count("program_state")).toBe(0);
    expect((await tracker(athlete, { today: TODAY })).state).toEqual(NOT_SET);
  });

  it("a rejected value does not overwrite a saved poundage", async () => {
    const { athlete } = await setupAthletes();
    await savePoundage(athlete, 24);

    expect((await savePoundage(athlete, 0)).status).toBe(400);

    expect((await tracker(athlete, { today: TODAY })).state.currentPoundage).toBe(24);
  });

  it("malformed JSON is a 400 and an anonymous request a 401", async () => {
    const { athlete } = await setupAthletes();
    const malformed = await apiJson("/api/plan/poundage", { method: "POST", body: "{poundage:", headers: { "content-type": "application/json" }, cookie: athlete.cookie });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "Invalid JSON body" });

    const anonymous = await apiJson("/api/plan/poundage", { json: { poundage: 24 } });
    expect(anonymous.status).toBe(401);
    expect(await count("program_state")).toBe(0);
  });
});

describe("schedule adjustments from the default state", () => {
  it("'back' at cycle 1 / week 1 is clamped and leaves the poundage not set", async () => {
    const { athlete } = await setupAthletes();

    const adjusted = await apiJson("/api/plan/adjust", { json: { adjustment: "back", today: TODAY }, cookie: athlete.cookie });

    expect(adjusted.status).toBe(200);
    expect(adjusted.body).toEqual({ currentCycle: 1, currentWeek: 1, adjustment: "back" });
    expect((await tracker(athlete, { today: TODAY })).state).toEqual(NOT_SET);
  });

  it("'forward' moves to week 2 without inventing a poundage", async () => {
    const { athlete } = await setupAthletes();

    const adjusted = await apiJson("/api/plan/adjust", { json: { adjustment: "forward", today: TODAY }, cookie: athlete.cookie });

    expect(adjusted.body).toEqual({ currentCycle: 1, currentWeek: 2, adjustment: "forward" });
    expect((await tracker(athlete, { today: TODAY })).state).toEqual({ currentPoundage: null, currentCycle: 1, currentWeek: 2 });
    expect(await rows("SELECT current_poundage FROM program_state WHERE user_id = ?", athlete.user.id)).toEqual([{ current_poundage: null }]);
  });

  it("'skip' repeats the current week next week", async () => {
    const { athlete } = await setupAthletes();

    const adjusted = await apiJson("/api/plan/adjust", { json: { adjustment: "skip", today: TODAY }, cookie: athlete.cookie });

    expect(adjusted.body).toEqual({ currentCycle: 1, currentWeek: 1, adjustment: "skip" });
    expect((await tracker(athlete, { today: dayPlus(MONDAY, 7) })).state).toEqual(NOT_SET);
    expect((await tracker(athlete, { today: dayPlus(MONDAY, 14) })).state).toEqual({ currentPoundage: null, currentCycle: 1, currentWeek: 2 });
  });
});

describe("starter plan and saved overrides", () => {
  const override = { dayKey: "wed", sessionType: "SPT", detail: "Band work", prescription: "3 x 30 s holds at 24 lb" };

  it("a saved day keeps its override; every other day still shows the starter plan", async () => {
    const { athlete } = await setupAthletes();

    const saved = await apiJson("/api/plan/sessions", { json: override, cookie: athlete.cookie });

    expect(saved.status).toBe(200);
    const payload = await tracker(athlete, { today: TODAY });
    expect(planOf(payload)).toEqual(STARTER_PLAN.map((day) => (day.dayKey === "wed" ? { ...day, ...override } : day)));
    expect(payload.plannedSessions.map((day) => [day.dayKey, day.updatedAt === null])).toEqual([
      ["mon", true], ["tue", true], ["wed", false], ["thu", true], ["fri", true], ["sat", true], ["sun", true],
    ]);
  });

  it("an override stored before this release is returned unchanged", async () => {
    const { athlete, rival } = await setupAthletes();
    // As written by the previous version: a row in planned_session_overrides.
    await rows(`INSERT INTO planned_session_overrides (user_id, day_key, session_type, detail, prescription, updated_at)
      VALUES (?, 'mon', 'Range', 'Blank boss', '120 arrows at 5 m, 24 lb', 1750000000000)`, athlete.user.id);

    const payload = await tracker(athlete, { today: TODAY });

    expect(payload.plannedSessions[0]).toMatchObject({
      dayKey: "mon", sessionType: "Range", detail: "Blank boss", prescription: "120 arrows at 5 m, 24 lb", updatedAt: new Date(1750000000000).toISOString(),
    });
    expect(planOf(payload).slice(1)).toEqual(STARTER_PLAN.slice(1));
    // Another athlete is unaffected.
    expect(planOf(await tracker(rival, { today: TODAY }))).toEqual(STARTER_PLAN);
  });

  it("a coach's edit for one athlete shows for that athlete only", async () => {
    const { coach, athlete, rival } = await setupSquad();

    const edited = await apiJson(`/api/coach/athletes/${athlete.user.id}/plan/sessions`, { method: "PUT", json: { ...override, dayKey: "sat" }, cookie: coach.cookie });

    expect(edited.status).toBe(200);
    expect(planOf(await tracker(athlete, { today: TODAY }))[5]).toEqual({ ...STARTER_PLAN[5], ...override, dayKey: "sat" });
    expect(planOf(await tracker(rival, { today: TODAY }))).toEqual(STARTER_PLAN);
    expect(await count("planned_session_overrides", "user_id = ?", coach.user.id)).toBe(0);
  });
});

it.each(["forward", "back", "skip"])("initial %s adjustment uses local Monday ahead of UTC", async (adjustment) => {
  vi.setSystemTime(new Date("2026-09-27T20:00:00Z"));
  const { athlete } = await setupAthletes();
  const result = await apiJson("/api/plan/adjust", { cookie: athlete.cookie, json: { adjustment, today: "2026-09-28" } });
  expect(result.status).toBe(200);
  expect((await tracker(athlete, { today: "2026-09-28" })).state).toEqual({ ...NOT_SET, currentWeek: adjustment === "forward" ? 2 : 1 });
});
