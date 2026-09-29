import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type TeamMeal } from "../../frontend/src/api";
import { CoachToday } from "../../frontend/src/features/coach/CoachToday";
import { CoachFuel } from "../../frontend/src/features/fuel/CoachFuel";
import { Nutrition } from "../../frontend/src/features/fuel/Nutrition";
import { localDate } from "../../frontend/src/lib/dates";
import { recipe, stubFetch, teamAthlete, teamMeal } from "./coach-fixtures";

function show(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("CoachToday", () => {
  it("lists athletes with cycle arrows and both averages, using — when no sessions were logged", async () => {
    const overview = vi.spyOn(api, "coachOverview").mockResolvedValue({ athletes: [
      teamAthlete(),
      teamAthlete({ id: "athlete-2", username: "newbie", displayName: "", currentPoundage: null, currentCycle: 1, currentWeek: 1,
        cycleArrows: 0, cycleSessions: 0, averagePerWeek: 0, averagePerSession: null }),
    ] });
    show(<CoachToday onOpenAthlete={() => {}} />);
    const robin = await screen.findByRole("button", { name: /^Open Robin Archer’s training overview/ });
    expect(overview).toHaveBeenCalledWith(localDate());
    expect(within(robin).getByText("Cycle 2, Week 3")).toBeTruthy();
    expect(within(robin).getByText("28 lb")).toBeTruthy();
    const stat = (card: HTMLElement, label: string) => within(card).getByText(label).previousElementSibling?.textContent;
    expect(stat(robin, "Cycle arrows")).toBe("135");
    expect(stat(robin, "Average / week")).toBe("45");
    expect(stat(robin, "Average / session")).toBe("33.75");
    expect(robin.getAttribute("aria-label")).toContain("33.75 average per session");
    // No display name: falls back to the username.
    const newbie = screen.getByRole("button", { name: /^Open newbie’s training overview/ });
    expect(within(newbie).getByText("Poundage not set")).toBeTruthy();
    expect(stat(newbie, "Cycle arrows")).toBe("0");
    expect(stat(newbie, "Average / week")).toBe("0");
    expect(stat(newbie, "Average / session")).toBe("—");
    expect(newbie.getAttribute("aria-label")).toContain("no sessions logged");
    expect(within(robin).getByRole("img").getAttribute("aria-label")).toContain("Week 1: 60 arrows");
  });

  it("rounds fractional averages for display only", async () => {
    vi.spyOn(api, "coachOverview").mockResolvedValue({ athletes: [teamAthlete({ averagePerWeek: 22.5, averagePerSession: 100 / 3 })] });
    show(<CoachToday onOpenAthlete={() => {}} />);
    const card = await screen.findByRole("button", { name: /^Open Robin Archer/ });
    expect(within(card).getByText("22.5")).toBeTruthy();
    expect(within(card).getByText("33.33")).toBeTruthy();
  });

  it("calls onOpenAthlete with the tapped athlete's id", async () => {
    vi.spyOn(api, "coachOverview").mockResolvedValue({ athletes: [teamAthlete(), teamAthlete({ id: "athlete-2", displayName: "Second" })] });
    const open = vi.fn();
    show(<CoachToday onOpenAthlete={open} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Open Second’s training overview/ }));
    expect(open).toHaveBeenCalledWith("athlete-2");
  });

  it("shows an empty state with no active athletes", async () => {
    vi.spyOn(api, "coachOverview").mockResolvedValue({ athletes: [] });
    show(<CoachToday onOpenAthlete={() => {}} />);
    expect(await screen.findByText("No active athletes yet. Go to Team to invite your first athlete.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an error state and retries", async () => {
    const overview = vi.spyOn(api, "coachOverview").mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue({ athletes: [teamAthlete()] });
    show(<CoachToday onOpenAthlete={() => {}} />);
    expect(await screen.findByText("Athletes couldn’t be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Robin Archer");
    expect(overview).toHaveBeenCalledTimes(2);
  });
});

describe("CoachFuel", () => {
  it.each(["Coach Kim", "Coach"])("shows the API author %s in the card and details", async (author) => {
    stubFetch({ "/api/coach/meals": { meals: [teamMeal({ id: 7, author })] } });
    show(<CoachFuel />);
    expect(await screen.findByText(`by ${author}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View full recipe for Rice bowl" }));
    expect(within(screen.getByRole("dialog")).getByText(new RegExp(`^Team meal · ${author} · `))).toBeTruthy();
  });

  it("adds a meal from the form and refetches the list", async () => {
    let meals: TeamMeal[] = [];
    const list = vi.spyOn(api, "listTeamMeals").mockImplementation(async () => ({ meals }));
    const add = vi.spyOn(api, "addTeamMeal").mockImplementation(async (input) => {
      const meal = teamMeal({ id: 1, ...input });
      meals = [meal];
      return meal;
    });
    show(<CoachFuel />);
    await screen.findByText("No team meals yet. Add the first one above.");
    expect(screen.getByRole("heading", { name: "Add meal" })).toBeTruthy();
    // Whitespace passes the native `required` check but is rejected after trimming.
    fill("Meal name", "Pasta"); fill("Summary", "   "); fill("Ingredients", "x"); fill("Method", "y");
    fireEvent.click(screen.getByRole("button", { name: "Add meal" }));
    expect(screen.getByRole("alert").textContent).toBe("Fill in every field.");
    expect(add).not.toHaveBeenCalled();
    fill("Meal name", "  Pasta  "); fill("Summary", "Carbs"); fill("Ingredients", "Pasta, sauce"); fill("Method", "Boil");
    fireEvent.click(screen.getByRole("button", { name: "Add meal" }));
    expect(await screen.findByText("Meal added. Athletes will see it in Fuel.")).toBeTruthy();
    expect(add).toHaveBeenCalledWith({ name: "Pasta", summary: "Carbs", ingredients: "Pasta, sauce", instructions: "Boil" });
    await screen.findByRole("heading", { name: "Pasta" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(value("Meal name")).toBe("");
  });

  it("edits a meal through the same form, and Cancel discards the edit", async () => {
    let meals = [teamMeal({ id: 7, name: "Rice bowl" })];
    vi.spyOn(api, "listTeamMeals").mockImplementation(async () => ({ meals }));
    const update = vi.spyOn(api, "updateTeamMeal").mockImplementation(async ({ id, ...input }) => {
      meals = [teamMeal({ id, ...input })];
      return meals[0];
    });
    show(<CoachFuel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Rice bowl" }));
    expect(screen.getByRole("heading", { name: "Edit meal" })).toBeTruthy();
    expect(value("Meal name")).toBe("Rice bowl");
    expect(value("Method")).toBe("Cook both");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Add meal" })).toBeTruthy();
    expect(value("Meal name")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Edit Rice bowl" }));
    fill("Meal name", "Rice bowl deluxe");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Meal updated.")).toBeTruthy();
    expect(update).toHaveBeenCalledWith({ id: 7, name: "Rice bowl deluxe", summary: "Rice and beans", ingredients: "Rice, beans", instructions: "Cook both" });
    await screen.findByRole("heading", { name: "Rice bowl deluxe" });
    expect(screen.getByRole("heading", { name: "Add meal" })).toBeTruthy();
  });

  it("resets the form when the meal being edited was already deleted (404)", async () => {
    const list = vi.spyOn(api, "listTeamMeals").mockResolvedValueOnce({ meals: [teamMeal({ id: 7 })] }).mockResolvedValue({ meals: [] });
    vi.spyOn(api, "updateTeamMeal").mockRejectedValue(new ApiError(404, "Meal not found"));
    show(<CoachFuel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Rice bowl" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("That meal was already deleted.")).toBeTruthy();
    await screen.findByText("No team meals yet. Add the first one above.");
    expect(screen.getByRole("heading", { name: "Add meal" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("deletes only after confirmation", async () => {
    let meals = [teamMeal({ id: 7 }), teamMeal({ id: 8, name: "Smoothie", author: "Other Coach" })];
    vi.spyOn(api, "listTeamMeals").mockImplementation(async () => ({ meals }));
    const remove = vi.spyOn(api, "deleteTeamMeal").mockImplementation(async ({ id }) => { meals = meals.filter((m) => m.id !== id); return { ok: true }; });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    show(<CoachFuel />);
    // Any coach may delete another coach's meal.
    expect(await screen.findByText("by Other Coach")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Smoothie" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("Smoothie");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Smoothie" }));
    expect(await screen.findByText("Meal deleted.")).toBeTruthy();
    expect(remove).toHaveBeenCalledWith({ id: 8 });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Smoothie" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Rice bowl" })).toBeTruthy();
  });

  it("shows a load error with retry", async () => {
    const list = vi.spyOn(api, "listTeamMeals").mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue({ meals: [teamMeal({ id: 1 })] });
    show(<CoachFuel />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Rice bowl" });
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("athlete Fuel feed", () => {
  it("refreshes an open meal's details and shows its removal after refetch", () => {
    const meal = recipe({ id: 1, source: "team", author: "Coach" });
    const view = render(<Nutrition recipes={[meal]} />);
    fireEvent.click(screen.getByRole("button", { name: "View full recipe for Oats" }));
    expect(within(screen.getByRole("dialog")).getByText(/^From your coach · Coach · /)).toBeTruthy();
    view.rerender(<Nutrition recipes={[{ ...meal, instructions: "Updated method" }]} />);
    expect(within(screen.getByRole("dialog")).getByText("Updated method")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByText("Simmer")).toBeNull();
    view.rerender(<Nutrition recipes={[]} />);
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Meal removed" })).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByText("Updated method")).toBeNull();
  });

  it("labels team meals From your coach, keeps server order and shows provenance in details", () => {
    render(<Nutrition recipes={[
      recipe({ id: 1, source: "team", name: "Team stew", author: "Coach Kim", updatedAt: "2026-09-28T12:00:00.000Z" }),
      recipe({ id: 1, source: "own", name: "My oats", updatedAt: "2026-09-27T12:00:00.000Z" }),
    ]} />);
    const cards = screen.getAllByRole("article");
    expect(cards.map((card) => within(card).getByRole("heading").textContent)).toEqual(["Team stew", "My oats"]);
    expect(within(cards[0]).getByText("From your coach")).toBeTruthy();
    expect(within(cards[1]).queryByText("From your coach")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View full recipe for Team stew" }));
    expect(within(screen.getByRole("dialog")).getByText(/^From your coach · Coach Kim · /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close recipe details" }));
    fireEvent.click(screen.getByRole("button", { name: "View full recipe for My oats" }));
    expect(within(screen.getByRole("dialog")).getByText(/^Daily check-in · /)).toBeTruthy();
  });

  it("renders a javascript: payload in team meal text as plain text", () => {
    const payload = "javascript:alert(1)";
    const html = `<img src=x onerror="alert(1)"><a href="${payload}">click</a>`;
    render(<Nutrition recipes={[recipe({ id: 9, source: "team", name: payload, summary: html, ingredients: payload, instructions: html, author: "Coach" })]} />);
    expect(screen.getByRole("heading", { name: payload })).toBeTruthy();
    expect(screen.getByText(html)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `View full recipe for ${payload}` }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(html)).toHaveLength(2);
    expect(within(dialog).getByText(payload, { selector: "p" })).toBeTruthy();
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[href^='javascript']")).toBeNull();
  });

  it("shows the updated empty-state copy", () => {
    render(<Nutrition recipes={[]} />);
    expect(screen.getByText("Meals from your daily check-ins and your coaches will appear here.")).toBeTruthy();
  });
});
