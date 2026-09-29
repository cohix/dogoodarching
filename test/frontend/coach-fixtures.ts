// Shared fixtures for the work item 0003 coach/athlete shell tests.
import { vi } from "vitest";
import type { CoachAthleteOverview, CoachTeamAthlete, CycleSummary, Me, Recipe, TeamMeal, TrackerPayload } from "../../frontend/src/api";

export const athleteMe: Me = { id: "athlete-1", username: "archer", role: "athlete", isOwner: false };
export const coachMe: Me = { id: "coach-1", username: "coach", role: "coach", isOwner: false };

export const cycle = (n: number, arrows = [10, 20, 0, 0, 0, 0]): CycleSummary => ({
  cycle: n,
  weeks: arrows.map((count, i) => ({ weekNumber: i + 1, weekStart: `2026-0${n}-0${i + 1}`, arrows: count, dayStatuses: [] })),
});

export const teamAthlete = (overrides: Partial<CoachTeamAthlete> = {}): CoachTeamAthlete => ({
  id: "athlete-1", username: "archer", displayName: "Robin Archer", currentPoundage: 28, currentCycle: 2, currentWeek: 3,
  currentCycleSummary: cycle(2, [60, 45, 30, 0, 0, 0]), cycleArrows: 135, cycleSessions: 4, averagePerWeek: 45, averagePerSession: 33.75,
  ...overrides,
});

export const athleteOverview = (overrides: Partial<CoachAthleteOverview> = {}): CoachAthleteOverview => ({
  state: { currentCycle: 2, currentWeek: 3, currentPoundage: 28 }, weeklyPlans: [], plannedSessions: [],
  weeklyArrows: [{ week: "Sep 14", arrows: 60 }, { week: "Sep 21", arrows: 45 }],
  cycleSummaries: [cycle(1, [5, 5, 5, 5, 5, 5]), cycle(2, [60, 45, 30, 0, 0, 0])],
  ...overrides,
});

export const tracker = (overrides: Partial<TrackerPayload> = {}): TrackerPayload => ({
  state: { currentCycle: 1, currentWeek: 1, currentPoundage: 28 }, weeklyPlans: [], plannedSessions: [], sessions: [], practiceScores: [],
  currentWeeklyNote: { id: null, weekStart: "2026-09-28", notes: "", updatedAt: null }, historicalWeeklyNotes: [], weeklyArrows: [], cycleSummaries: [],
  milestoneChecks: {}, maintenanceChecks: {}, maintenanceItems: [], setups: [], inspiration: null, recipes: [],
  ...overrides,
});

export const recipe = (overrides: Partial<Recipe> & Pick<Recipe, "id" | "source">): Recipe => ({
  name: "Oats", summary: "Warm oats", ingredients: "Oats, milk", instructions: "Simmer", updatedAt: "2026-09-27T12:00:00.000Z",
  key: `${overrides.source}:${overrides.id}`, author: null, ...overrides,
});

export const teamMeal = (overrides: Partial<TeamMeal> & Pick<TeamMeal, "id">): TeamMeal => ({
  name: "Rice bowl", summary: "Rice and beans", ingredients: "Rice, beans", instructions: "Cook both", author: "Coach Kim", updatedBy: null,
  createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z", ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Stubs `fetch` with a path router (path without query string → body). Every
 * requested URL is recorded; unknown paths answer 404 so a stray request is
 * visible rather than hanging.
 */
export function stubFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url, window.location.origin).pathname;
    if (!(path in routes)) return json({ error: `Unexpected ${path}` }, 404);
    const route = routes[path];
    return json(typeof route === "function" ? route(init) : route);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, urls };
}

/** recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks. */
export function stubResizeObserver() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
}

/** True when `a` comes before `b` in document order. */
export const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
