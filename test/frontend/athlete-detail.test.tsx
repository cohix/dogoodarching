import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CoachAthleteOverview } from "../../frontend/src/api";
import { TeamTab } from "../../frontend/src/features/team/TeamTab";
import { TrainingLog } from "../../frontend/src/features/log/TrainingLog";
import { localDate } from "../../frontend/src/lib/dates";
import { athleteOverview, before, coachMe, cycle, stubResizeObserver, tracker } from "./coach-fixtures";

function show(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
async function openDetail(overview: CoachAthleteOverview) {
  vi.spyOn(api, "athleteOverview").mockResolvedValue(overview);
  show(<TeamTab me={coachMe} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open archer’s training overview" }));
  return screen.findByRole("heading", { name: "Current cycle" });
}
beforeEach(() => {
  stubResizeObserver();
  vi.spyOn(api, "listAthletes").mockResolvedValue({ athletes: [{ id: "athlete-1", username: "archer", createdAt: "2026-09-01T00:00:00Z", deactivatedAt: null }] });
  vi.spyOn(api, "listInvites").mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("AthleteDetail", () => {
  it("orders current cycle, arrows summary and chart before PlanEditor, with earlier cycles after it", async () => {
    const overview = athleteOverview({ cycleSummaries: [cycle(1, [5, 5, 5, 5, 5, 5]), cycle(2, [60, 45, 30, 0, 0, 0]), cycle(3, [1, 1, 1, 1, 1, 1])], state: { currentCycle: 2, currentWeek: 3, currentPoundage: 28 } });
    const current = await openDetail(overview);
    expect(api.athleteOverview).toHaveBeenCalledWith("athlete-1", localDate());
    const currentSection = current.closest("section")!;
    expect(within(currentSection).getByRole("heading", { name: "Cycle 2" })).toBeTruthy();
    expect(within(currentSection).getByLabelText("Cycle 2: 135 arrows total, 45 average arrows per week")).toBeTruthy();
    const arrowsHeading = screen.getByRole("heading", { name: "Arrows by week" });
    const summary = screen.getByRole("button", { name: /^Open archer’s arrows by week chart\. 105 arrows across 2 logged weeks/ });
    expect(summary.textContent).toContain("105 arrows across 2 logged weeks");
    const chart = screen.getByRole("img", { name: /^Weekly arrows bar chart\. Sep 14: 60 arrows, Sep 21: 45 arrows/ });
    const plan = screen.getByRole("heading", { name: "Six-week technical cycle" });
    const earlier = screen.getByRole("heading", { name: "Earlier cycles" });
    for (const [a, b] of [[current, arrowsHeading], [arrowsHeading, summary], [summary, chart], [chart, plan], [plan, earlier]]) expect(before(a, b)).toBe(true);
    // Earlier cycles: every cycle but the current, newest first.
    const earlierCycles = within(earlier.closest("section")!).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(earlierCycles).toEqual(["Cycle 3", "Cycle 1"]);
    expect(within(earlier.closest("section")!).getByLabelText("Cycle 1: 30 arrows total, 5 average arrows per week")).toBeTruthy();
    expect(screen.getByText(/Cycle 2, Week 3 · 28 lb/)).toBeTruthy();
  });

  it("hides Earlier cycles when only the current cycle exists", async () => {
    await openDetail(athleteOverview({ cycleSummaries: [cycle(2)] }));
    expect(screen.getByRole("heading", { name: "Six-week technical cycle" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Earlier cycles" })).toBeNull();
  });

  it("shows empty states for no cycle data and no logged weeks", async () => {
    await openDetail(athleteOverview({ cycleSummaries: [], weeklyArrows: [] }));
    expect(screen.getByText("No cycle data yet.")).toBeTruthy();
    expect(screen.getByText("No logged weeks yet. The chart starts with archer’s first range log.")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Weekly arrows bar chart/ })).toBeNull();
    expect(screen.getByRole("button", { name: /0 arrows across 0 logged weeks/ })).toBeTruthy();
  });

  it("opens the full-screen arrows chart from the summary and closes it", async () => {
    await openDetail(athleteOverview());
    fireEvent.click(screen.getByRole("button", { name: /^Open archer’s arrows by week chart/ }));
    const dialog = screen.getByRole("dialog", { name: "Arrows by week" });
    expect(within(dialog).getByRole("img", { name: /^Weekly arrows bar chart\. Sep 14: 60 arrows/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ArrowHistoryModal in the Log tab", () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  it("opens the shared chart from the Log summary and closes with Escape", () => {
    const data = tracker({ weeklyArrows: [{ week: "Sep 21", arrows: 40 }, { week: "Sep 28", arrows: 12 }] });
    render(<QueryClientProvider client={client()}><TrainingLog data={data} onSaved={() => {}} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open arrows by week chart. 52 arrows across 2 logged weeks" }));
    const dialog = screen.getByRole("dialog", { name: "Arrows by week" });
    expect(within(dialog).getByRole("img", { name: "Weekly arrows bar chart. Sep 21: 40 arrows, Sep 28: 12 arrows" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the athlete empty-state copy with no logged weeks", () => {
    render(<QueryClientProvider client={client()}><TrainingLog data={tracker()} onSaved={() => {}} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^Open arrows by week chart\. 0 arrows/ }));
    const dialog = screen.getByRole("dialog", { name: "Arrows by week" });
    expect(within(dialog).getByText("The chart starts with your first range log.")).toBeTruthy();
    expect(within(dialog).queryByRole("img")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close arrows by week chart" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
