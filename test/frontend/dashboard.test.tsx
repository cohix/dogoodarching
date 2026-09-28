import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type TrackerPayload } from "../../frontend/src/api";
import { localDate } from "../../frontend/src/lib/dates";
import { Dashboard } from "../../frontend/src/features/dashboard/Dashboard";
import { PoundagePrompt } from "../../frontend/src/features/dashboard/PoundagePrompt";

const empty: TrackerPayload = {
  state: { currentCycle: 1, currentWeek: 1, currentPoundage: null }, weeklyPlans: [], plannedSessions: [], sessions: [], practiceScores: [],
  currentWeeklyNote: { id: null, weekStart: "2026-09-28", notes: "", updatedAt: null }, historicalWeeklyNotes: [], weeklyArrows: [], cycleSummaries: [],
  milestoneChecks: {}, maintenanceChecks: {}, maintenanceItems: [], setups: [], inspiration: null, recipes: [],
};
const client = () => new QueryClient({ defaultOptions: { mutations: { retry: false } } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("asks an unset athlete for poundage, sends the local day and reveals milestones after refresh", async () => {
  const save = vi.spyOn(api, "savePoundage").mockResolvedValue({ currentPoundage: 28 });
  function Harness() {
    const [data, setData] = useState(empty);
    return <Dashboard data={data} onLog={() => {}} onSaved={() => setData({ ...empty, state: { ...empty.state, currentPoundage: 28 } })} />;
  }
  render(<QueryClientProvider client={client()}><Harness /></QueryClientProvider>);
  expect(screen.getByRole("heading", { name: "Set your bow poundage" })).toBeTruthy();
  expect(screen.queryByText("Next milestone")).toBeNull();
  fireEvent.change(screen.getByLabelText("Current bow poundage in pounds"), { target: { value: "28" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Set your bow poundage" })).toBeNull());
  expect(save).toHaveBeenCalledWith({ poundage: 28, today: localDate() });
  expect(screen.getByText("Next milestone")).toBeTruthy();
});

it("retains the poundage prompt after a failed save and allows retry", async () => {
  const save = vi.spyOn(api, "savePoundage").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ currentPoundage: 26 });
  const saved = vi.fn();
  render(<QueryClientProvider client={client()}><PoundagePrompt onSaved={saved} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Current bow poundage in pounds"), { target: { value: "26" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledTimes(2);
});

it.each(["0", "101", "24.5"])("rejects invalid poundage %s without a request", (value) => {
  const save = vi.spyOn(api, "savePoundage");
  render(<QueryClientProvider client={client()}><PoundagePrompt onSaved={() => {}} /></QueryClientProvider>);
  const input = screen.getByLabelText("Current bow poundage in pounds") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.form!);
  expect(screen.getByRole("alert").textContent).toContain("whole number between 1 and 100");
  expect(save).not.toHaveBeenCalled();
});
