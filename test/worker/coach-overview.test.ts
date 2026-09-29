import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import { schema } from "../../src/db";
import {
  getCoachOverview, getCoachTeamOverview, getTrackerPayload, TEAM_OVERVIEW_ID_CHUNK, type CoachTeamOverview, type TrackerPayload,
} from "../../src/services/dashboard";
import { plannedSessionDefaults } from "../../src/services/plan";
import { setupTeam } from "./auth-fixtures";
import { api, apiJson, bootstrapCoach, bootstrapTeam } from "./helpers";

const overviewFields = ["cycleSummaries", "plannedSessions", "state", "weeklyArrows", "weeklyPlans"] as const;
const secrets = {
  notes: "PRIVATE_SESSION_NOTES_9d2e",
  focus: "PRIVATE_SESSION_FOCUS_71ac",
  score: "PRIVATE_SESSION_SCORE_3b8f",
  weekly: "PRIVATE_WEEKLY_NOTE_8f10",
  setup: "PRIVATE_BOW_SETUP_b149",
  inspiration: "PRIVATE_INSPIRATION_0a39",
  maintenance: "PRIVATE_MAINTENANCE_f811",
  milestone: "PRIVATE_MILESTONE_164d",
};

function captureOverviewQueries() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(env.DB, {
    schema,
    logger: { logQuery(sql, params) { queries.push({ sql, params: [...params] }); } },
  });
  return { db, queries };
}

function expectSafeQueries(queries: ReturnType<typeof captureOverviewQueries>["queries"], userId: string, start: string, end: string) {
  // Capture only the service call, excluding seeding, auth and the athlete's
  // dashboard. An exact table multiset also rejects new private-table reads.
  expect(queries).toHaveLength(6);
  expect(queries.map(({ sql }) => /from "([^"]+)"/.exec(sql)?.[1]).sort()).toEqual([
    "cycle_week_plans", "planned_session_attachments", "planned_session_overrides",
    "program_state", "training_sessions", "training_sessions",
  ]);
  for (const { sql, params } of queries) {
    expect(sql).toMatch(/^select /);
    expect(sql).not.toMatch(/\*|\b(?:notes|focus|score|practice_scores|practice_score_ends|weekly_notes|bow_setups|maintenance_items|maintenance_checks|milestone_checks|inspiration_entries)\b/i);
    expect(params[0]).toBe(userId);
  }
  const aggregates = queries.filter(({ sql }) => sql.includes('from "training_sessions"'));
  expect(aggregates).toHaveLength(2);
  expect(aggregates.filter(({ sql }) => sql.startsWith('select distinct "session_date" from'))).toHaveLength(1);
  expect(aggregates.filter(({ sql }) => sql.includes('sum("arrows")') && sql.includes("group by date("))).toHaveLength(1);
  for (const { sql, params } of aggregates) {
    // Check every referenced identifier, not just absence of the known secrets:
    // individual rows, new private columns and qualified SELECT * also fail.
    const identifiers = [...sql.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    expect([...new Set(identifiers)].sort()).toEqual(sql.startsWith("select distinct")
      ? ["session_date", "training_sessions", "user_id"]
      : ["arrows", "session_date", "training_sessions", "user_id"]);
    expect(sql).toContain('"session_date" >= ?');
    expect(sql).toContain('"session_date" < ?');
    expect(params).toEqual([userId, start, end]);
  }
}

it("queries only coach-safe plans and aggregates, with private seeds absent and athlete dashboard parity", async () => {
  const { coach, athlete } = await bootstrapTeam();
  const db = drizzle(env.DB, { schema });
  const userId = athlete.user.id;
  const today = "2026-01-01";
  const updatedAt = new Date("2025-12-22T12:00:00Z");
  await db.insert(schema.programState).values({ userId, currentPoundage: null, currentCycle: 2, currentWeek: 1, updatedAt });
  await db.insert(schema.cycleWeekPlans).values({ userId, weekNumber: 2, primaryFocus: "Public plan focus", updatedAt });
  await db.insert(schema.plannedSessionOverrides).values({ userId, dayKey: "mon", sessionType: "Range", detail: "Public plan detail", prescription: "60 arrows", updatedAt });
  await db.insert(schema.plannedSessionAttachments).values([
    { userId, dayKey: "mon", kind: "link", label: "Plan link", url: "https://example.org/plan", createdAt: updatedAt },
    { userId, dayKey: "mon", kind: "document", label: "Plan PDF", blobKey: "plan.pdf", mimeType: "application/pdf", createdAt: updatedAt },
  ]);
  const datesAndArrows: Array<[string, number]> = [
    ["2025-11-09", 9999], // Before the first cycle: excluded.
    ["2025-11-10", 7], ["2025-11-17", 8], ["2025-11-24", 9],
    ["2025-12-01", 10], ["2025-12-08", 11], ["2025-12-15", 12],
    ["2025-12-28", 20], // Sunday still belongs to the previous ISO week.
    ["2025-12-29", 40], ["2025-12-29", 60], ["2025-12-31", 0],
    ["2026-01-03", 10], ["2026-02-01", 5],
    ["2026-02-02", 8888], // Exclusive end of the current cycle: excluded.
    ...Array.from({ length: 105 }, (): [string, number] => ["2025-12-29", 1]),
  ];
  // Individual statements stay below D1's parameter limit. More than 100
  // sessions proves aggregation is independent of the private log page limit.
  for (const [sessionDate, arrows] of datesAndArrows) {
    await db.insert(schema.trainingSessions).values({ userId, sessionDate, arrows, sessionType: "Range", notes: secrets.notes, focus: secrets.focus, score: secrets.score });
  }
  await db.insert(schema.trainingSessions).values({ userId: coach.user.id, sessionDate: "2025-12-29", sessionType: "Range", arrows: 7777 });
  await db.insert(schema.weeklyNotes).values({ userId, weekStart: "2025-12-29", notes: secrets.weekly });
  await db.insert(schema.bowSetups).values({ userId, poundage: 24, name: secrets.setup });
  await db.insert(schema.inspirationEntries).values({ userId, thoughtText: secrets.inspiration, videoTitle: "", videoUrl: "", recipeName: secrets.inspiration, recipeSummary: "", recipeIngredients: "" });
  await db.insert(schema.maintenanceItems).values({ userId, section: "Weekly", label: secrets.maintenance });
  await db.insert(schema.maintenanceChecks).values({ userId, key: secrets.maintenance, checked: true });
  await db.insert(schema.milestoneChecks).values({ userId, key: secrets.milestone, checked: true });
  const [practiceScore] = await db.insert(schema.practiceScores).values({ userId, scoreDate: today, total: 270 }).returning();
  for (let endNumber = 1; endNumber <= 10; endNumber++) {
    await db.insert(schema.practiceScoreEnds).values({ userId, scoreId: practiceScore!.id, endNumber, arrow1: 8, arrow2: 9, arrow3: 10, endTotal: 27 });
  }

  const captured = captureOverviewQueries();
  const overview = await getCoachOverview(captured.db, userId, today);
  expectSafeQueries(captured.queries, userId, "2025-11-10", "2026-02-02");
  const route = await apiJson<typeof overview>(`/api/coach/athletes/${userId}/overview?today=${today}`, { cookie: coach.cookie });
  expect(route.status).toBe(200);
  expect(route.body).toEqual(overview);
  expect(Object.keys(route.body).sort()).toEqual(overviewFields);
  const tracker = await apiJson<TrackerPayload>(`/api/tracker?today=${today}`, { cookie: athlete.cookie });
  expect(tracker.status).toBe(200);
  for (const secret of Object.values(secrets)) {
    expect(JSON.stringify(tracker.body)).toContain(secret); // Non-vacuous privacy seed.
    expect(JSON.stringify(route.body)).not.toContain(secret);
  }
  for (const field of overviewFields) expect(overview[field]).toEqual(tracker.body[field]);
  expect(overview.state).toEqual({ currentPoundage: null, currentCycle: 2, currentWeek: 2 });
  expect(overview.weeklyArrows).toEqual([
    { week: "2025-W47", arrows: 8 }, { week: "2025-W48", arrows: 9 },
    { week: "2025-W49", arrows: 10 }, { week: "2025-W50", arrows: 11 },
    { week: "2025-W51", arrows: 12 }, { week: "2025-W52", arrows: 20 },
    { week: "2026-W01", arrows: 215 }, { week: "2026-W05", arrows: 5 },
  ]);
  expect(overview.cycleSummaries).toHaveLength(2);
  expect(overview.cycleSummaries[0]!.weeks[0]).toMatchObject({ weekStart: "2025-11-10", arrows: 7 });
  expect(overview.cycleSummaries[1]!.weeks[1]).toEqual({
    weekNumber: 2, weekStart: "2025-12-29", arrows: 215,
    dayStatuses: ["completed", "skipped", "completed", "upcoming", "upcoming", "completed"],
  });
  expect(overview.plannedSessions[0]).toMatchObject({ detail: "Public plan detail", updatedAt: updatedAt.toISOString(), attachments: [
    { label: "Plan link", url: "https://example.org/plan" },
    { label: "Plan PDF", url: expect.stringMatching(/^\/api\/plan\/attachments\/\d+\/file$/) },
  ] });
});

it.each(["missing", null, 28] as const)("preserves defaults and poundage (%s) without private queries", async (poundage) => {
  const db = drizzle(env.DB, { schema });
  const userId = "default-athlete";
  const today = "2026-09-28";
  await db.insert(schema.users).values({ id: userId, username: userId, passwordHash: "unused", role: "athlete" });
  if (poundage !== "missing") {
    await db.insert(schema.programState).values({ userId, currentPoundage: poundage, currentCycle: 1, currentWeek: 1, updatedAt: new Date(`${today}T12:00:00Z`) });
  }
  const captured = captureOverviewQueries();
  const overview = await getCoachOverview(captured.db, userId, today);
  expectSafeQueries(captured.queries, userId, "2026-09-28", "2026-11-09");
  const tracker = await getTrackerPayload(db, userId, today);
  for (const field of overviewFields) expect(overview[field]).toEqual(tracker[field]);
  expect(overview.state).toEqual({ currentPoundage: poundage === "missing" ? null : poundage, currentCycle: 1, currentWeek: 1 });
  expect(overview.weeklyPlans).toEqual([]);
  expect(overview.weeklyArrows).toEqual([]);
  expect(overview.plannedSessions).toEqual(plannedSessionDefaults.map(fallback => ({ ...fallback, updatedAt: null, attachments: [] })));
  expect(overview.cycleSummaries[0]!.weeks).toHaveLength(6);
  for (const week of overview.cycleSummaries[0]!.weeks) {
    expect(week.arrows).toBe(0);
    expect(week.dayStatuses).toEqual(Array(6).fill("upcoming"));
  }
});

// ---------------------------------------------------------------------------
// Coach Today: GET /api/coach/overview and getCoachTeamOverview (0003 §1)
// ---------------------------------------------------------------------------

type TeamOverviewAthlete = CoachTeamOverview["athletes"][number];

const TEAM_FIELDS = [
  "averagePerSession", "averagePerWeek", "currentCycle", "currentCycleSummary", "currentPoundage", "currentWeek",
  "cycleArrows", "cycleSessions", "displayName", "id", "username",
];
const PRIVATE_SQL = /\*|\b(?:notes|focus|score|custom_activity|duration_minutes|practice_scores|practice_score_ends|weekly_notes|bow_setups|maintenance_items|maintenance_checks|milestone_checks|inspiration_entries|team_meals|password_hash|cycle_week_plans|planned_session_overrides|planned_session_attachments)\b/i;

function identifiersOf(sql: string): string[] {
  return [...new Set([...sql.matchAll(/"([^"]+)"/g)].map((match) => match[1]!))].sort();
}

/**
 * The team overview's privacy boundary: one roster query on `users`, then per
 * chunk of athletes exactly one `program_state` and two `training_sessions`
 * aggregates, each referencing only the listed columns and binding at most
 * D1's 100 parameters.
 */
function expectSafeTeamQueries(queries: ReturnType<typeof captureOverviewQueries>["queries"], athleteIds: string[], window: [string, string]) {
  const chunkCount = Math.ceil(athleteIds.length / TEAM_OVERVIEW_ID_CHUNK);
  expect(queries).toHaveLength(1 + 3 * chunkCount);
  expect(queries.map(({ sql }) => /from "([^"]+)"/.exec(sql)?.[1]).sort()).toEqual([
    ...Array(chunkCount).fill("program_state"), ...Array(chunkCount * 2).fill("training_sessions"), "users",
  ].sort());
  const boundIds: unknown[] = [];
  for (const { sql, params } of queries) {
    expect(sql).toMatch(/^select /);
    expect(sql).not.toMatch(PRIVATE_SQL);
    expect(params.length).toBeLessThanOrEqual(100);
    const table = /from "([^"]+)"/.exec(sql)![1];
    if (table === "users") {
      expect(identifiersOf(sql)).toEqual(["deactivated_at", "id", "role", "username", "users"]);
      expect(params).toEqual(["athlete"]);
    } else if (table === "program_state") {
      expect(identifiersOf(sql)).toEqual(["current_cycle", "current_poundage", "current_week", "program_state", "updated_at", "user_id"]);
      expect(params.length).toBeLessThanOrEqual(TEAM_OVERVIEW_ID_CHUNK);
      boundIds.push(...params);
    } else {
      // Session rows are never read, only grouped sums/counts and distinct dates.
      expect(identifiersOf(sql)).toEqual(sql.startsWith("select distinct")
        ? ["session_date", "training_sessions", "user_id"]
        : ["arrows", "id", "session_date", "training_sessions", "user_id"]);
      if (!sql.startsWith("select distinct")) {
        expect(sql).toContain('sum("arrows")');
        expect(sql).toContain('count("id")');
        expect(sql).toMatch(/group by "training_sessions"\."user_id", date\(|group by "user_id", date\(/);
      }
      expect(sql).toContain('"session_date" >= ?');
      expect(sql).toContain('"session_date" < ?');
      expect(params.slice(-2)).toEqual(window);
    }
  }
  // Every athlete's id is bound exactly once to program_state, and nothing else is.
  expect(boundIds.sort()).toEqual([...athleteIds].sort());
}

async function insertAthlete(id: string, username: string, extra: { deactivatedAt?: Date; role?: "athlete" | "coach" } = {}) {
  await drizzle(env.DB, { schema }).insert(schema.users).values({
    id, username, passwordHash: "unused", role: extra.role ?? "athlete", deactivatedAt: extra.deactivatedAt ?? null,
  });
}

async function insertSessions(userId: string, sessions: Array<[string, number]>) {
  if (sessions.length === 0) return;
  await env.DB.batch(sessions.map(([sessionDate, arrows]) => env.DB.prepare(
    "INSERT INTO training_sessions (user_id, session_date, session_type, arrows, focus, notes, score, created_at) VALUES (?, ?, 'Range', ?, ?, ?, ?, ?)",
  ).bind(userId, sessionDate, arrows, secrets.focus, secrets.notes, secrets.score, Date.now())));
}

async function insertState(userId: string, currentPoundage: number | null, currentCycle: number, currentWeek: number, anchor: string) {
  await env.DB.prepare("INSERT INTO program_state (user_id, current_poundage, current_cycle, current_week, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, currentPoundage, currentCycle, currentWeek, Date.parse(`${anchor}T12:00:00Z`)).run();
}

/** Sessions logged inside the athlete's current cycle, counted straight from D1. */
async function sessionsInCycle(userId: string, cycleStart: string): Promise<number> {
  const end = new Date(Date.parse(`${cycleStart}T00:00:00Z`) + 42 * 86_400_000).toISOString().slice(0, 10);
  return (await env.DB.prepare("SELECT count(*) AS n FROM training_sessions WHERE user_id = ? AND session_date >= ? AND session_date < ?")
    .bind(userId, cycleStart, end).first<number>("n")) ?? 0;
}

/** Each card matches the per-athlete overview (and so the athlete's own Dashboard) for the same `today`. */
async function expectParity(athletes: TeamOverviewAthlete[], today: string) {
  const db = drizzle(env.DB, { schema });
  for (const athlete of athletes) {
    expect(Object.keys(athlete).sort()).toEqual(TEAM_FIELDS);
    const single = await getCoachOverview(db, athlete.id, today);
    const dashboard = await getTrackerPayload(db, athlete.id, today);
    expect(single.cycleSummaries).toEqual(dashboard.cycleSummaries);
    expect(single.state).toEqual(dashboard.state);
    expect(athlete.currentPoundage).toBe(single.state.currentPoundage);
    expect(athlete.currentCycle).toBe(single.state.currentCycle);
    expect(athlete.currentWeek).toBe(single.state.currentWeek);
    const current = single.cycleSummaries[single.state.currentCycle - 1]!;
    expect(athlete.currentCycleSummary).toEqual(current);
    // The athlete Dashboard hero: cycle total and total / max(1, current week).
    const dashboardTotal = current.weeks.reduce((sum, week) => sum + week.arrows, 0);
    expect(athlete.cycleArrows).toBe(dashboardTotal);
    expect(athlete.averagePerWeek).toBe(dashboardTotal / Math.max(1, single.state.currentWeek));
    const sessions = await sessionsInCycle(athlete.id, current.weeks[0]!.weekStart);
    expect(athlete.cycleSessions).toBe(sessions);
    expect(athlete.averagePerSession).toBe(sessions === 0 ? null : dashboardTotal / sessions);
  }
}

describe("coach team overview (GET /api/coach/overview)", () => {
  it("lists only active athletes by display name, with coach-safe queries, exact figures and dashboard parity", async () => {
    const { coach, athlete } = await bootstrapTeam(); // athlete: "athlete", no program_state, never logged
    const today = "2026-01-01"; // Thursday; this week's Monday is 2025-12-29
    await insertAthlete("amy-id", "amy");
    await insertAthlete("bob-id", "Bob"); // no program_state row: loadProgramState defaults
    await insertAthlete("dana-id", "dana");
    await insertAthlete("carl-id", "carl", { deactivatedAt: new Date("2025-12-01T00:00:00Z") });
    await insertAthlete("coach2-id", "aaa-coach", { role: "coach" });
    // amy: cycle 2 week 1 anchored the week before → cycle 2 week 2 today; cycle 2 = [2025-12-22, 2026-02-02).
    await insertState("amy-id", 30, 2, 1, "2025-12-22");
    await insertSessions("amy-id", [
      ["2025-12-15", 12], // previous cycle, inside the shared window: excluded
      ["2025-12-22", 30], ["2025-12-22", 10], // two sessions on one day: two sessions, one completed day
      ["2025-12-28", 20], // Sunday belongs to week 1
      ["2025-12-29", 40], ["2025-12-31", 0], // a zero-arrow session still counts as a session
      ["2026-02-01", 5], // last day of the cycle
      ["2026-02-02", 8888], // first day of the next cycle: excluded
    ]);
    // dana: week 1 today, so average per week divides by 1; last week's session predates her cycle.
    await insertState("dana-id", 28, 1, 1, today);
    await insertSessions("dana-id", [["2025-12-26", 50], ["2025-12-29", 90]]);
    // Private rows for excluded users must not leak into anyone's figures.
    await insertSessions("carl-id", [["2025-12-29", 7777]]);
    await insertSessions(coach.user.id, [["2025-12-29", 6666]]);
    await insertSessions("coach2-id", [["2025-12-29", 5555]]);

    const captured = captureOverviewQueries();
    const overview = await getCoachTeamOverview(captured.db, today);
    const activeIds = ["amy-id", athlete.user.id, "bob-id", "dana-id"];
    expectSafeTeamQueries(captured.queries, activeIds, ["2025-11-24", "2026-02-09"]);

    // Case-insensitive display-name order; carl (deactivated) and both coaches (incl. the owner) are absent.
    expect(overview.athletes.map((a) => a.username)).toEqual(["amy", "athlete", "Bob", "dana"]);
    expect(overview.athletes.map((a) => a.displayName)).toEqual(["amy", "athlete", "Bob", "dana"]);
    const [amy, fresh, bob, dana] = overview.athletes as [TeamOverviewAthlete, TeamOverviewAthlete, TeamOverviewAthlete, TeamOverviewAthlete];
    expect(amy).toMatchObject({ currentPoundage: 30, currentCycle: 2, currentWeek: 2, cycleArrows: 105, cycleSessions: 6, averagePerWeek: 52.5, averagePerSession: 17.5 });
    expect(amy.currentCycleSummary.weeks.map((w) => [w.weekStart, w.arrows])).toEqual([
      ["2025-12-22", 60], ["2025-12-29", 40], ["2026-01-05", 0], ["2026-01-12", 0], ["2026-01-19", 0], ["2026-01-26", 5],
    ]);
    expect(amy.currentCycleSummary.weeks[1]!.dayStatuses).toEqual(["completed", "skipped", "completed", "upcoming", "upcoming", "upcoming"]);
    for (const empty of [fresh, bob]) {
      // Poundage unset, never logged: zero arrows, "—" per session (null), week 1 of cycle 1 anchored to today.
      expect(empty).toMatchObject({ currentPoundage: null, currentCycle: 1, currentWeek: 1, cycleArrows: 0, cycleSessions: 0, averagePerWeek: 0, averagePerSession: null });
      expect(empty.currentCycleSummary.weeks[0]!.weekStart).toBe("2025-12-29");
      expect(empty.currentCycleSummary.weeks[0]!.dayStatuses).toEqual(["skipped", "skipped", "skipped", "upcoming", "upcoming", "upcoming"]);
    }
    expect(dana).toMatchObject({ currentPoundage: 28, currentCycle: 1, currentWeek: 1, cycleArrows: 90, cycleSessions: 1, averagePerWeek: 90, averagePerSession: 90 });
    await expectParity(overview.athletes, today);
    // A missing program_state row is not written by reading the overview.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM program_state WHERE user_id IN (?, ?)").bind("bob-id", athlete.user.id).first("n")).toBe(0);

    // The route returns the same body; the athlete's own Dashboard numbers agree.
    const route = await apiJson<CoachTeamOverview>(`/api/coach/overview?today=${today}`, { cookie: coach.cookie });
    expect(route.status).toBe(200);
    expect(route.body).toEqual(overview);
    for (const secret of [secrets.notes, secrets.focus, secrets.score, "7777", "6666", "5555", "8888", "coach2-id", "carl"]) {
      expect(JSON.stringify(route.body)).not.toContain(secret);
    }
    const own = await apiJson<TrackerPayload>(`/api/tracker?today=${today}`, { cookie: athlete.cookie });
    expect(own.body.cycleSummaries[own.body.state.currentCycle - 1]).toEqual(fresh.currentCycleSummary);
  });

  it("the route is coach-only: every coach gets 200, athletes 403, anonymous 401, a bad today 400", async () => {
    const team = await setupTeam();
    for (const coach of [team.owner, team.coach]) {
      const result = await apiJson<CoachTeamOverview>("/api/coach/overview?today=2026-09-28", { cookie: coach.cookie });
      expect(result.status).toBe(200);
      expect(result.body.athletes.map((a) => a.username)).toEqual(["athleteA", "athleteB"]);
    }
    for (const athlete of [team.athleteA, team.athleteB]) {
      const result = await apiJson("/api/coach/overview", { cookie: athlete.cookie });
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: "Forbidden" });
      expect((await api("/api/coach/overview?today=nope", { cookie: athlete.cookie })).status).toBe(403);
    }
    expect((await api("/api/coach/overview")).status).toBe(401);
    for (const bad of ["nope", "2026-02-30", "2026-9-28"]) {
      const result = await apiJson(`/api/coach/overview?today=${bad}`, { cookie: team.coach.cookie });
      expect(result.status, bad).toBe(400);
      expect(result.body).toEqual({ error: "Invalid today parameter" });
    }
  });

  it("an empty team answers from the roster query alone; the owner never appears", async () => {
    const { coach } = await bootstrapTeam();
    await env.DB.prepare("DELETE FROM users WHERE role = 'athlete'").run();
    const captured = captureOverviewQueries();
    expect(await getCoachTeamOverview(captured.db, "2026-09-28")).toEqual({ athletes: [] });
    expect(captured.queries).toHaveLength(1);
    const route = await apiJson("/api/coach/overview", { cookie: coach.cookie });
    expect(route.body).toEqual({ athletes: [] });
  });

  it("a deactivated athlete is excluded and reappears when reactivated", async () => {
    const team = await setupTeam();
    const names = async () => (await apiJson<CoachTeamOverview>("/api/coach/overview?today=2026-09-28", { cookie: team.coach.cookie })).body.athletes.map((a) => a.username);
    expect(await names()).toEqual(["athleteA", "athleteB"]);
    expect((await api(`/api/coach/athletes/${team.athleteA.user.id}/deactivate`, { method: "POST", cookie: team.owner.cookie })).status).toBe(200);
    expect(await names()).toEqual(["athleteB"]);
    expect((await api(`/api/coach/athletes/${team.athleteA.user.id}/reactivate`, { method: "POST", cookie: team.owner.cookie })).status).toBe(200);
    expect(await names()).toEqual(["athleteA", "athleteB"]);
  });

  it("a cycle rollover on today starts the new cycle at week 1 and drops the finished cycle's arrows", async () => {
    await insertAthlete("eve-id", "eve");
    // Cycle 1 week 6 in the week of 2025-12-22 → on Monday 2025-12-29 the athlete is in cycle 2, week 1.
    await insertState("eve-id", 26, 1, 6, "2025-12-22");
    await insertSessions("eve-id", [["2025-12-27", 50], ["2025-12-29", 20]]);
    const overview = await getCoachTeamOverview(drizzle(env.DB, { schema }), "2025-12-29");
    const [eve] = overview.athletes;
    expect(eve).toMatchObject({ currentCycle: 2, currentWeek: 1, cycleArrows: 20, cycleSessions: 1, averagePerWeek: 20, averagePerSession: 20 });
    expect(eve!.currentCycleSummary.cycle).toBe(2);
    expect(eve!.currentCycleSummary.weeks[0]).toEqual({
      weekNumber: 1, weekStart: "2025-12-29", arrows: 20, dayStatuses: ["completed", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"],
    });
    // The day before, the same athlete is still in week 6 of cycle 1 with last week's arrows.
    const before = (await getCoachTeamOverview(drizzle(env.DB, { schema }), "2025-12-28")).athletes[0]!;
    expect(before).toMatchObject({ currentCycle: 1, currentWeek: 6, cycleArrows: 50, cycleSessions: 1, averagePerWeek: 50 / 6 });
    await expectParity(overview.athletes, "2025-12-29");
    await expectParity([before], "2025-12-28");
  });

  it("uses the client's today, not UTC, and defaults to UTC today when none is given", async () => {
    const { coach } = await bootstrapTeam();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-27T20:00:00Z")); // Sunday in UTC, already Monday for a client east of UTC
      const local = await apiJson<CoachTeamOverview>("/api/coach/overview?today=2026-09-28", { cookie: coach.cookie });
      expect(local.body.athletes[0]!.currentCycleSummary.weeks[0]!.weekStart).toBe("2026-09-28");
      const utc = await apiJson<CoachTeamOverview>("/api/coach/overview", { cookie: coach.cookie });
      expect(utc.body.athletes[0]!.currentCycleSummary.weeks[0]!.weekStart).toBe("2026-09-21");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the query count does not grow per athlete, and chunking keeps every statement under D1's 100 bound parameters", async () => {
    const today = "2026-09-30";
    const coach = await bootstrapCoach("coach"); // coaches are never part of the roster
    const runFor = async (total: number) => {
      const existing = (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'athlete'").first<number>("n")) ?? 0;
      const ids = Array.from({ length: total - existing }, (_unused, index) => `bulk-${String(existing + index).padStart(4, "0")}`);
      for (let i = 0; i < ids.length; i += 40) {
        const slice = ids.slice(i, i + 40);
        await env.DB.batch(slice.flatMap((id) => [
          env.DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'unused', 'athlete', 0)").bind(id, id),
          // Arrows encode the athlete, so a chunking mix-up shows up as a wrong total.
          env.DB.prepare("INSERT INTO training_sessions (user_id, session_date, session_type, arrows, created_at) VALUES (?, '2026-09-29', 'Range', ?, 0)")
            .bind(id, Number(id.slice(5)) + 1),
        ]));
      }
      const captured = captureOverviewQueries();
      const overview = await getCoachTeamOverview(captured.db, today);
      const allIds = (await env.DB.prepare("SELECT id FROM users WHERE role = 'athlete'").all<{ id: string }>()).results.map((row) => row.id);
      expectSafeTeamQueries(captured.queries, allIds, ["2026-08-24", "2026-11-09"]);
      expect(overview.athletes).toHaveLength(total);
      for (const athlete of overview.athletes) {
        const arrows = Number(athlete.id.slice(5)) + 1;
        expect(athlete, athlete.id).toMatchObject({ cycleArrows: arrows, cycleSessions: 1, averagePerWeek: arrows, averagePerSession: arrows });
      }
      return captured.queries.length;
    };
    // Constant within a chunk: 1 roster + 3 grouped queries, for 1, 2 or a full chunk of athletes.
    expect(await runFor(1)).toBe(4);
    expect(await runFor(2)).toBe(4);
    expect(await runFor(TEAM_OVERVIEW_ID_CHUNK)).toBe(4);
    // Past one chunk the queries grow per chunk of 90 athletes, never per athlete. 250 athletes
    // (250 ids alone would exceed D1's 100 bound parameters) take 1 + 3 × 3 queries.
    expect(await runFor(TEAM_OVERVIEW_ID_CHUNK + 1)).toBe(7);
    expect(await runFor(250)).toBe(10);
    // Local D1 enforces the limit: one unchunked IN list over the same ids fails.
    const everyId = (await env.DB.prepare("SELECT id FROM users WHERE role = 'athlete'").all<{ id: string }>()).results.map((row) => row.id);
    await expect(env.DB.prepare(`SELECT count(*) AS n FROM program_state WHERE user_id IN (${everyId.map(() => "?").join(", ")})`).bind(...everyId).all()).rejects.toThrow();
    // End to end through D1 (which enforces the parameter limit) the route answers for all of them.
    const route = await apiJson<CoachTeamOverview>(`/api/coach/overview?today=${today}`, { cookie: coach.cookie });
    expect(route.status).toBe(200);
    expect(route.body.athletes).toHaveLength(250);
    await expectParity(route.body.athletes.slice(0, 3), today);
  });
});
