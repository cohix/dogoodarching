import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../frontend/src/App";
import type { Me } from "../../frontend/src/api";
import { athleteNav, coachNav, navGridClass, visibleTab } from "../../frontend/src/components/navigation";
import { SettingsTab } from "../../frontend/src/features/settings/SettingsTab";
import { athleteMe, athleteOverview, coachMe, stubFetch, stubResizeObserver, teamAthlete, tracker } from "./coach-fixtures";

// The athlete-only tabs are replaced by sentinels that count renders, so a
// coach test can prove they were never mounted.
const mounts = vi.hoisted(() => ({ dashboard: 0, log: 0, plan: 0, gear: 0 }));
vi.mock("../../frontend/src/features/dashboard/Dashboard", () => ({ Dashboard: () => { mounts.dashboard++; return <p>athlete dashboard</p>; } }));
vi.mock("../../frontend/src/features/log/TrainingLog", () => ({ TrainingLog: () => { mounts.log++; return <p>athlete log</p>; } }));
vi.mock("../../frontend/src/features/plan/TrainingPlan", () => ({ TrainingPlan: () => { mounts.plan++; return <p>athlete plan</p>; } }));
vi.mock("../../frontend/src/features/gear/BowAndGear", () => ({ BowAndGear: () => { mounts.gear++; return <p>athlete gear</p>; } }));

const clients: QueryClient[] = [];
function show(element: ReactNode, me: Me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(["me"], me);
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
const navLabels = () => within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const go = (label: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: label }));
const header = () => screen.getByRole("banner");
const title = () => within(header()).getByRole("heading", { level: 1 }).textContent;
const noPoundageLabel = () => {
  expect(header().textContent).not.toMatch(/\d+\s*lb/);
  expect(header().textContent).not.toMatch(/poundage/i);
};

const coachRoutes = (extra: Record<string, unknown> = {}) => ({
  "/api/auth/me": coachMe,
  "/api/coach/overview": { athletes: [teamAthlete()] },
  "/api/coach/meals": { meals: [] },
  "/api/coach/athletes": { athletes: [{ id: "athlete-1", username: "archer", createdAt: "2026-09-01T00:00:00Z", deactivatedAt: null }] },
  "/api/auth/invites": [],
  "/api/coach/athletes/athlete-1/overview": athleteOverview(),
  ...extra,
});

beforeEach(() => { Object.assign(mounts, { dashboard: 0, log: 0, plan: 0, gear: 0 }); stubResizeObserver(); });
afterEach(() => { cleanup(); clients.forEach((c) => c.clear()); clients.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("coach shell", () => {
  it("renders exactly Today, Fuel, Team and Settings, never mounts athlete tabs and never requests /api/tracker", async () => {
    const { urls } = stubFetch(coachRoutes());
    show(<App />, coachMe);
    expect(navLabels()).toEqual(["Today", "Fuel", "Team", "Settings"]);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-current")).toBe("page");
    expect(title()).toBe("Today");
    await screen.findByText("Robin Archer");
    for (const label of ["Fuel", "Team", "Settings", "Today"]) {
      go(label);
      expect(title()).toBe(label);
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-current")).toBe("page");
    }
    await screen.findByText("Robin Archer");
    expect(mounts).toEqual({ dashboard: 0, log: 0, plan: 0, gear: 0 });
    expect(screen.queryByRole("button", { name: /^(Log|Plan|Gear)$/ })).toBeNull();
    expect(urls.some((url) => url.includes("/api/tracker"))).toBe(false);
    expect(urls.some((url) => url.startsWith("/api/coach/overview?today="))).toBe(true);
  });

  it("shows no poundage label and no History action in the coach header on any tab", async () => {
    stubFetch(coachRoutes());
    show(<App />, coachMe);
    await screen.findByText("Robin Archer");
    for (const label of ["Today", "Fuel", "Team", "Settings"]) {
      go(label);
      noPoundageLabel();
      expect(within(header()).queryByRole("button")).toBeNull();
    }
  });

  it("opens an athlete in Team from a Today card, and Back to team returns to the team list", async () => {
    const { urls } = stubFetch(coachRoutes());
    show(<App />, coachMe);
    fireEvent.click(await screen.findByRole("button", { name: /^Open Robin Archer’s training overview/ }));
    expect(title()).toBe("Team");
    expect(screen.getByRole("button", { name: "Team" }).getAttribute("aria-current")).toBe("page");
    await screen.findByRole("heading", { name: "Current cycle" });
    expect(screen.getByRole("heading", { name: "archer" })).toBeTruthy();
    expect(urls.some((url) => url.startsWith("/api/coach/athletes/athlete-1/overview?today="))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "← Back to team" }));
    expect(await screen.findByRole("heading", { name: "Invites" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open archer’s training overview" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Current cycle" })).toBeNull();
  });

  it("clears an opened athlete when the coach taps a bottom-nav tab", async () => {
    stubFetch(coachRoutes());
    show(<App />, coachMe);
    fireEvent.click(await screen.findByRole("button", { name: /^Open Robin Archer’s training overview/ }));
    await screen.findByRole("heading", { name: "Current cycle" });
    go("Team");
    expect(await screen.findByRole("heading", { name: "Invites" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Current cycle" })).toBeNull();
  });

  it("shows no export or import in coach Settings", () => {
    stubFetch(coachRoutes());
    show(<App />, coachMe);
    go("Settings");
    expect(screen.queryByRole("heading", { name: "Export my data" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Import data" })).toBeNull();
    expect(screen.queryByLabelText("Choose an export file to import")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download export" })).toBeNull();
  });
});

describe("athlete shell", () => {
  it("keeps the six-tab athlete nav and the Today History action, with no header poundage label", async () => {
    const { urls } = stubFetch({ "/api/auth/me": athleteMe, "/api/tracker": tracker() });
    show(<App />, athleteMe);
    await screen.findByText("athlete dashboard");
    expect(navLabels()).toEqual(["Today", "Log", "Plan", "Gear", "Fuel", "Settings"]);
    expect(title()).toBe("Today");
    expect(within(header()).getByRole("button", { name: "History" })).toBeTruthy();
    noPoundageLabel();
    for (const [label, sentinel] of [["Log", "athlete log"], ["Plan", "athlete plan"], ["Gear", "athlete gear"]] as const) {
      go(label);
      expect(screen.getByText(sentinel)).toBeTruthy();
      expect(title()).toBe(label);
      expect(within(header()).queryByRole("button", { name: "History" })).toBeNull();
      noPoundageLabel();
    }
    go("Fuel");
    noPoundageLabel();
    go("Settings");
    expect(screen.getByRole("heading", { name: "Export my data" })).toBeTruthy();
    noPoundageLabel();
    go("Today");
    fireEvent.click(within(header()).getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog", { name: "Cycle history" })).toBeTruthy();
    expect(urls.filter((url) => url.startsWith("/api/tracker?today=")).length).toBeGreaterThan(0);
    expect(urls.some((url) => url.startsWith("/api/coach/"))).toBe(false);
  });
});

describe("navigation helpers", () => {
  it("defines the coach and athlete navs and their grid classes", () => {
    expect(coachNav.map((item) => [item.id, item.label])).toEqual([["dashboard", "Today"], ["nutrition", "Fuel"], ["team", "Team"], ["settings", "Settings"]]);
    expect(athleteNav.map((item) => item.label)).toEqual(["Today", "Log", "Plan", "Gear", "Fuel", "Settings"]);
    expect(navGridClass(coachNav)).toBe("grid-cols-4");
    expect(navGridClass(athleteNav)).toBe("grid-cols-6");
  });

  it("falls back to Today for a stale tab outside the coach nav", () => {
    for (const stale of ["log", "plan", "bow"] as const) expect(visibleTab(coachNav, stale)).toBe("dashboard");
    for (const item of coachNav) expect(visibleTab(coachNav, item.id)).toBe(item.id);
    expect(visibleTab(athleteNav, "team")).toBe("dashboard");
    expect(visibleTab(athleteNav, "bow")).toBe("bow");
  });
});

describe("SettingsTab export/import", () => {
  it.each([["athlete", athleteMe, true], ["coach", coachMe, false]] as const)("%s sees export/import: %s", (_role, me, visible) => {
    stubFetch({});
    show(<SettingsTab me={me} />, me);
    expect(Boolean(screen.queryByRole("heading", { name: "Export my data" }))).toBe(visible);
    expect(Boolean(screen.queryByRole("heading", { name: "Import data" }))).toBe(visible);
    expect(Boolean(screen.queryByRole("button", { name: "Download export" }))).toBe(visible);
    expect(Boolean(screen.queryByLabelText("Choose an export file to import"))).toBe(visible);
  });
});
