// Team meals (0003 §3): coach CRUD on /api/coach/meals, RBAC, CSRF and rate
// limits, the merge into the athlete tracker payload's `recipes[]`, author
// deletion, and exclusion from personal export/import.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { RateLimitBinding } from "../../src/db";
import { countRows, setupTeam, type Team } from "./auth-fixtures";
import { api, apiJson, DEFAULT_PASSWORD, type Session } from "./helpers";

interface TeamMeal {
  id: number; name: string; summary: string; ingredients: string; instructions: string;
  author: string; updatedBy: string | null; createdAt: string; updatedAt: string;
}

interface Recipe {
  key: string; source: "own" | "team"; id: number; name: string; summary: string; ingredients: string;
  instructions: string; author: string | null; updatedAt: string;
}

interface TrackerRecipes {
  recipes: Recipe[];
  inspiration: null | { recipeName: string; thoughtText: string; updatedAt: string };
}

const MEAL_FIELDS = ["author", "createdAt", "id", "ingredients", "instructions", "name", "summary", "updatedAt", "updatedBy"];
const RECIPE_FIELDS = ["author", "id", "ingredients", "instructions", "key", "name", "source", "summary", "updatedAt"];

function mealBody(overrides: Partial<Record<"name" | "summary" | "ingredients" | "instructions", string>> = {}) {
  return { name: "Overnight oats", summary: "Slow-release breakfast", ingredients: "Oats, milk, berries", instructions: "Soak overnight.", ...overrides };
}

async function createMeal(coach: Session, overrides: Parameters<typeof mealBody>[0] = {}): Promise<TeamMeal> {
  const { status, body } = await apiJson<TeamMeal>("/api/coach/meals", { json: mealBody(overrides), cookie: coach.cookie });
  if (status !== 200) throw new Error(`create meal failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

async function listMeals(coach: Session): Promise<TeamMeal[]> {
  const { status, body } = await apiJson<{ meals: TeamMeal[] }>("/api/coach/meals", { cookie: coach.cookie });
  if (status !== 200) throw new Error(`list meals failed: ${status}`);
  return body.meals;
}

async function recipesOf(athlete: Session): Promise<TrackerRecipes> {
  const { status, body } = await apiJson<TrackerRecipes>("/api/tracker", { cookie: athlete.cookie });
  if (status !== 200) throw new Error(`tracker failed: ${status}`);
  return body;
}

async function mealRows() {
  return (await env.DB.prepare("SELECT * FROM team_meals ORDER BY id").all()).results;
}

function inspirationBody(recipeName: string) {
  return {
    thoughtText: `Thought for ${recipeName}`, videoTitle: "Form", videoUrl: "https://example.org/form",
    recipeName, recipeSummary: "Own summary", recipeIngredients: "Own ingredients", recipeInstructions: "Own method",
  };
}

async function insertMeal(authorId: string | null, name: string, createdAt: number, id: number | null = null): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO team_meals (id, author_id, name, summary, ingredients, instructions, created_at, updated_at)
    VALUES (?, ?, ?, 's', 'i', 'm', ?, ?) RETURNING id`).bind(id, authorId, name, createdAt, createdAt).first<{ id: number }>();
  return row!.id;
}

async function insertInspiration(userId: string, recipeName: string, updatedAt: number): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO inspiration_entries (user_id, thought_text, video_title, video_url, recipe_name, recipe_summary,
    recipe_ingredients, recipe_instructions, updated_at) VALUES (?, 't', 'v', 'https://example.org/v', ?, 's', 'i', 'm', ?) RETURNING id`)
    .bind(userId, recipeName, updatedAt).first<{ id: number }>();
  return row!.id;
}

afterEach(() => {
  env.RATE_LIMIT_MODE = "allow";
});

describe("coach meal CRUD", () => {
  it("creates, lists newest first, edits (full replace) and deletes, returning names but never user ids", async () => {
    const team = await setupTeam();
    const first = await createMeal(team.owner, { name: "Rice bowl" });
    expect(Object.keys(first).sort()).toEqual(MEAL_FIELDS);
    expect(first).toMatchObject({ ...mealBody({ name: "Rice bowl" }), author: "owner", updatedBy: null });
    expect(first.createdAt).toBe(first.updatedAt);
    const second = await createMeal(team.coach, { name: "Pasta" });
    expect(second.id).toBeGreaterThan(first.id);

    const listed = await listMeals(team.coach);
    expect(listed.map((meal) => meal.name)).toEqual(["Pasta", "Rice bowl"]);
    expect(listed[1]).toEqual(first);

    const edit = mealBody({ name: "Rice bowl v2", summary: "New", ingredients: "Rice", instructions: "Steam." });
    const updated = await apiJson<TeamMeal>(`/api/coach/meals/${first.id}`, { method: "PUT", json: edit, cookie: team.owner.cookie });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: first.id, ...edit, author: "owner", updatedBy: "owner", createdAt: first.createdAt });
    expect(Date.parse(updated.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    // Edits never reorder: the edited older meal stays second.
    expect((await listMeals(team.owner)).map((meal) => meal.name)).toEqual(["Pasta", "Rice bowl v2"]);

    const deleted = await apiJson(`/api/coach/meals/${second.id}`, { method: "DELETE", cookie: team.owner.cookie });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect((await listMeals(team.owner)).map((meal) => meal.id)).toEqual([first.id]);

    const text = JSON.stringify(await listMeals(team.owner));
    for (const id of [team.owner.user.id, team.coach.user.id]) expect(text).not.toContain(id);
  });

  it("any coach can edit or delete another coach's meal; updated_by records the acting coach", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    const byCoach = await apiJson<TeamMeal>(`/api/coach/meals/${meal.id}`, { method: "PUT", json: mealBody({ name: "Coach2 edit" }), cookie: team.coach.cookie });
    expect(byCoach.status).toBe(200);
    expect(byCoach.body).toMatchObject({ name: "Coach2 edit", author: "owner", updatedBy: "coach2" });
    expect(await env.DB.prepare("SELECT author_id, updated_by FROM team_meals WHERE id = ?").bind(meal.id).first())
      .toEqual({ author_id: team.owner.user.id, updated_by: team.coach.user.id });
    const byOwner = await apiJson<TeamMeal>(`/api/coach/meals/${meal.id}`, { method: "PUT", json: mealBody({ name: "Owner edit" }), cookie: team.owner.cookie });
    expect(byOwner.body).toMatchObject({ author: "owner", updatedBy: "owner" });
    expect((await listMeals(team.coach))[0]).toMatchObject({ name: "Owner edit", updatedBy: "owner" });

    const coachMeal = await createMeal(team.coach, { name: "Coach2 meal" });
    expect((await api(`/api/coach/meals/${coachMeal.id}`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(200);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
    expect(await countRows("team_meals")).toBe(0);
  });

  it("404 on editing or deleting a missing meal, 400 on a malformed id", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    for (const [method, json] of [["PUT", mealBody()], ["DELETE", undefined]] as const) {
      const missing = await apiJson(`/api/coach/meals/${meal.id + 100}`, { method, json, cookie: team.coach.cookie });
      expect(missing.status, method).toBe(404);
      expect(missing.body).toEqual({ error: "Meal not found" });
      for (const bad of ["0", "-1", "abc", "1.5"]) {
        const invalid = await apiJson(`/api/coach/meals/${bad}`, { method, json, cookie: team.coach.cookie });
        expect(invalid.status, `${method} ${bad}`).toBe(400);
        expect(invalid.body).toEqual({ error: "Invalid meal id" });
      }
    }
    // A meal deleted by one coach is a 404 for the other's stale edit and delete.
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(200);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "PUT", json: mealBody(), cookie: team.coach.cookie })).status).toBe(404);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(404);
    expect(await countRows("team_meals")).toBe(0);
  });

  it("validates every field: required, non-empty, and within the recipe limits; nothing is stored on a 400", async () => {
    const team = await setupTeam();
    const limits = { name: 200, summary: 1500, ingredients: 3000, instructions: 6000 } as const;
    const meal = await createMeal(team.owner);
    const before = await mealRows();
    for (const [field, max] of Object.entries(limits)) {
      const missing: Record<string, unknown> = mealBody();
      delete missing[field];
      for (const body of [missing, { ...mealBody(), [field]: "" }, { ...mealBody(), [field]: "x".repeat(max + 1) }, { ...mealBody(), [field]: 42 }]) {
        for (const [path, method] of [["/api/coach/meals", "POST"], [`/api/coach/meals/${meal.id}`, "PUT"]] as const) {
          const result = await apiJson<{ error: string }>(path, { method, json: body, cookie: team.coach.cookie });
          expect(result.status, `${method} ${field}`).toBe(400);
          expect(result.body).toEqual({ error: expect.any(String) });
        }
      }
    }
    for (const body of [null, [], "text", { ...mealBody(), name: null }]) {
      expect((await api("/api/coach/meals", { json: body, cookie: team.coach.cookie })).status).toBe(400);
    }
    expect((await api("/api/coach/meals", { body: "{", headers: { "content-type": "application/json" }, cookie: team.coach.cookie })).status).toBe(400);
    expect((await api("/api/coach/meals", { body: JSON.stringify(mealBody()), headers: { "content-type": "text/plain" }, cookie: team.coach.cookie })).status).toBe(415);
    expect(await mealRows()).toEqual(before);

    // Exactly at the limits is accepted and stored verbatim.
    const atMax = Object.fromEntries(Object.entries(limits).map(([field, max]) => [field, "y".repeat(max)]));
    const accepted = await apiJson<TeamMeal>("/api/coach/meals", { json: atMax, cookie: team.coach.cookie });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject(atMax);
  });

  it("stores script-like and javascript: text verbatim as plain JSON strings", async () => {
    const team = await setupTeam();
    const hostile = mealBody({
      name: "javascript:alert(1)", summary: "<img src=x onerror=alert(1)>", ingredients: "<script>alert('x')</script>", instructions: "  padded  \n",
    });
    const created = await apiJson<TeamMeal>("/api/coach/meals", { json: hostile, cookie: team.owner.cookie });
    expect(created.status).toBe(200);
    expect(created.response.headers.get("content-type")).toContain("application/json");
    expect(created.body).toMatchObject(hostile); // not trimmed, not escaped, not stripped
    expect((await recipesOf(team.athleteA)).recipes[0]).toMatchObject({ ...hostile, source: "team" });
  });

  it("two coaches posting or editing at the same time: no meal is lost, the last write wins", async () => {
    const team = await setupTeam();
    const posted = await Promise.all([createMeal(team.owner, { name: "From owner" }), createMeal(team.coach, { name: "From coach2" })]);
    expect(new Set(posted.map((meal) => meal.id)).size).toBe(2);
    expect((await listMeals(team.owner)).map((meal) => meal.name).sort()).toEqual(["From coach2", "From owner"]);

    const target = posted[0]!.id;
    const edits = await Promise.all([
      apiJson<TeamMeal>(`/api/coach/meals/${target}`, { method: "PUT", json: mealBody({ name: "Edit A" }), cookie: team.owner.cookie }),
      apiJson<TeamMeal>(`/api/coach/meals/${target}`, { method: "PUT", json: mealBody({ name: "Edit B" }), cookie: team.coach.cookie }),
    ]);
    expect(edits.map((edit) => edit.status)).toEqual([200, 200]);
    const final = (await listMeals(team.owner)).find((meal) => meal.id === target)!;
    expect(["Edit A", "Edit B"]).toContain(final.name);
    // The stored editor is the coach whose write landed last.
    expect(final.updatedBy).toBe(final.name === "Edit A" ? "owner" : "coach2");
    expect(await countRows("team_meals")).toBe(2);
  });
});

describe("access control", () => {
  const mealRoutes = (id: number) => [
    { method: "GET", path: "/api/coach/meals" },
    { method: "POST", path: "/api/coach/meals", json: mealBody() },
    { method: "PUT", path: `/api/coach/meals/${id}`, json: mealBody({ name: "Hijack" }) },
    { method: "DELETE", path: `/api/coach/meals/${id}` },
  ];

  it("athletes get 403 and anonymous callers 401 on every meal route; nothing changes", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    const before = await mealRows();
    for (const route of mealRoutes(meal.id)) {
      for (const athlete of [team.athleteA, team.athleteB]) {
        const result = await apiJson(route.path, { method: route.method, json: route.json, cookie: athlete.cookie });
        expect(result.status, `${route.method} ${route.path}`).toBe(403);
        expect(result.body).toEqual({ error: "Forbidden" });
        // RBAC runs before validation.
        if (route.json) expect((await api(route.path, { method: route.method, json: { nonsense: true }, cookie: athlete.cookie })).status).toBe(403);
      }
      expect((await api(route.path, { method: route.method, json: route.json })).status).toBe(401);
    }
    expect(await mealRows()).toEqual(before);
  });

  it("cross-site POST, PUT and DELETE are rejected by CSRF even with a coach cookie", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    const before = await mealRows();
    for (const route of mealRoutes(meal.id).filter((r) => r.method !== "GET")) {
      for (const proof of [{ origin: "https://attacker.test" }, { origin: null, headers: { "sec-fetch-site": "cross-site" } }, { origin: null }]) {
        const result = await apiJson(route.path, { method: route.method, json: route.json, cookie: team.coach.cookie, ...proof });
        expect(result.status, `${route.method} ${JSON.stringify(proof)}`).toBe(403);
        expect(result.body).toEqual({ error: "Same-origin request required" });
      }
      // Same-origin Fetch Metadata without Origin is accepted.
      const sameOrigin = await api(route.path, { method: route.method, json: route.json, cookie: team.coach.cookie, origin: null, headers: { "sec-fetch-site": "same-origin" } });
      expect(sameOrigin.status, `${route.method} same-origin`).toBe(200);
      if (route.method === "DELETE") break;
    }
    expect((await mealRows()).length).toBe(before.length); // one created, one deleted
  });
});

describe("rate limits", () => {
  const originalFive = env.RATE_LIMIT_5_PER_MIN;
  const originalTen = env.RATE_LIMIT_10_PER_MIN;
  afterEach(() => {
    env.RATE_LIMIT_5_PER_MIN = originalFive;
    env.RATE_LIMIT_10_PER_MIN = originalTen;
  });

  function record() {
    const calls: Array<[number, string]> = [];
    const binding = (n: number): RateLimitBinding => ({ limit: async ({ key }) => { calls.push([n, key]); return { success: true }; } });
    env.RATE_LIMIT_MODE = undefined;
    env.RATE_LIMIT_5_PER_MIN = binding(5);
    env.RATE_LIMIT_10_PER_MIN = binding(10);
    return calls;
  }

  it("every meal write selects the 10/min binding keyed by the acting coach; GET and athletes are not charged; invalid bodies still count", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    const calls = record();
    expect((await api("/api/coach/meals", { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api("/api/coach/meals", { json: mealBody(), cookie: team.coach.cookie })).status).toBe(200);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "PUT", json: mealBody(), cookie: team.owner.cookie })).status).toBe(200);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
    expect((await api("/api/coach/meals", { json: {}, cookie: team.coach.cookie })).status).toBe(400);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(404);
    expect((await api("/api/coach/meals", { json: mealBody(), cookie: team.athleteA.cookie })).status).toBe(403);
    expect(calls).toEqual([
      [10, `team-meal:${team.coach.user.id}`], [10, `team-meal:${team.owner.user.id}`], [10, `team-meal:${team.coach.user.id}`],
      [10, `team-meal:${team.coach.user.id}`], [10, `team-meal:${team.coach.user.id}`],
    ]);
  });

  it("a denied limiter returns 429 and an erroring one 503, with nothing written", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner);
    const before = await mealRows();
    for (const [mode, status] of [[`deny:team-meal:${team.coach.user.id}`, 429], ["deny:team-meal", 429], ["error", 503]] as const) {
      env.RATE_LIMIT_MODE = mode;
      for (const [path, method, json] of [["/api/coach/meals", "POST", mealBody()], [`/api/coach/meals/${meal.id}`, "PUT", mealBody({ name: "x" })], [`/api/coach/meals/${meal.id}`, "DELETE", undefined]] as const) {
        const result = await apiJson<{ error: string }>(path, { method, json, cookie: team.coach.cookie });
        expect(result.status, `${mode} ${method}`).toBe(status);
      }
      // Reading is never limited.
      expect((await api("/api/coach/meals", { cookie: team.coach.cookie })).status).toBe(200);
    }
    // Denial is per acting coach: the owner is unaffected by the coach's key.
    env.RATE_LIMIT_MODE = `deny:team-meal:${team.coach.user.id}`;
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "PUT", json: mealBody({ name: "Owner" }), cookie: team.owner.cookie })).status).toBe(200);
    env.RATE_LIMIT_MODE = "allow";
    expect((await mealRows()).length).toBe(before.length);
  });
});

describe("athlete tracker payload", () => {
  async function teamWithRecipes(): Promise<{ team: Team; ids: Record<string, number> }> {
    const team = await setupTeam();
    const t = Date.parse("2026-09-01T10:00:00Z");
    const minute = 60_000;
    const ownOld = await insertInspiration(team.athleteA.user.id, "Own old", t);
    const ids = {
      ownOld,
      // Same numeric id as an own row: the two sources have independent id spaces.
      teamOld: await insertMeal(team.owner.user.id, "Team old", t + minute, ownOld),
      ownNew: await insertInspiration(team.athleteA.user.id, "Own new", t + 2 * minute),
      teamNew: await insertMeal(team.coach.user.id, "Team new", t + 3 * minute),
      // Ties on the timestamp: team before own, then id desc within a source.
      ownTie: await insertInspiration(team.athleteA.user.id, "Own tie", t + 4 * minute),
      teamTieA: await insertMeal(team.owner.user.id, "Team tie A", t + 4 * minute),
      teamTieB: await insertMeal(team.owner.user.id, "Team tie B", t + 4 * minute),
    };
    await insertInspiration(team.athleteB.user.id, "Other athlete's own", t + 10 * minute);
    return { team, ids };
  }

  it("merges own and team recipes newest first with source and key; ids may collide across sources", async () => {
    const { team, ids } = await teamWithRecipes();
    const payload = await recipesOf(team.athleteA);
    expect(payload.recipes.map((recipe) => [recipe.key, recipe.name])).toEqual([
      [`team:${ids.teamTieB}`, "Team tie B"], [`team:${ids.teamTieA}`, "Team tie A"], [`own:${ids.ownTie}`, "Own tie"],
      [`team:${ids.teamNew}`, "Team new"], [`own:${ids.ownNew}`, "Own new"],
      [`team:${ids.teamOld}`, "Team old"], [`own:${ids.ownOld}`, "Own old"],
    ]);
    for (const recipe of payload.recipes) {
      expect(Object.keys(recipe).sort()).toEqual(RECIPE_FIELDS);
      expect(recipe.key).toBe(`${recipe.source}:${recipe.id}`);
      expect(recipe.author).toBe(recipe.source === "team" ? (recipe.id === ids.teamNew ? "coach2" : "owner") : null);
    }
    expect(new Set(payload.recipes.map((recipe) => recipe.key)).size).toBe(payload.recipes.length);
    // Ids collide across sources (independent tables), which is why clients key by `key`.
    expect(payload.recipes.filter((recipe) => recipe.id === ids.ownOld).map((recipe) => recipe.key).sort()).toEqual([`own:${ids.ownOld}`, `team:${ids.ownOld}`]);
    // Every athlete sees every team meal, but only their own check-in recipes.
    const other = await recipesOf(team.athleteB);
    expect(other.recipes.filter((recipe) => recipe.source === "team")).toHaveLength(4);
    expect(other.recipes.filter((recipe) => recipe.source === "own").map((recipe) => recipe.name)).toEqual(["Other athlete's own"]);
  });

  it("an edit changes a team meal's content and updatedAt but never its position; inspiration stays own-only", async () => {
    const { team, ids } = await teamWithRecipes();
    const before = await recipesOf(team.athleteA);
    expect(before.inspiration).toMatchObject({ recipeName: "Own tie" });

    const edited = await apiJson<TeamMeal>(`/api/coach/meals/${ids.teamOld}`, { method: "PUT", json: mealBody({ name: "Team old, edited" }), cookie: team.coach.cookie });
    expect(edited.status).toBe(200);
    const after = await recipesOf(team.athleteA);
    expect(after.recipes.map((recipe) => recipe.key)).toEqual(before.recipes.map((recipe) => recipe.key));
    const recipe = after.recipes.find((r) => r.key === `team:${ids.teamOld}`)!;
    expect(recipe).toMatchObject({ name: "Team old, edited", author: "owner", updatedAt: edited.body.updatedAt });
    // A new team meal (the newest recipe overall) never becomes the athlete's inspiration.
    await createMeal(team.owner, { name: "Brand new team meal" });
    const latest = await recipesOf(team.athleteA);
    expect(latest.recipes[0]).toMatchObject({ source: "team", name: "Brand new team meal" });
    expect(latest.inspiration).toEqual(before.inspiration);
  });

  it("an athlete with no check-ins gets only team meals and a null inspiration; deleted meals disappear on refetch", async () => {
    const team = await setupTeam();
    const meal = await createMeal(team.owner, { name: "Soup" });
    const payload = await recipesOf(team.athleteB);
    expect(payload.inspiration).toBeNull();
    expect(payload.recipes).toEqual([{
      key: `team:${meal.id}`, source: "team", id: meal.id, name: "Soup", summary: meal.summary, ingredients: meal.ingredients,
      instructions: meal.instructions, author: "owner", updatedAt: meal.updatedAt,
    }]);
    expect((await api(`/api/coach/meals/${meal.id}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
    expect((await recipesOf(team.athleteB)).recipes).toEqual([]);
  });
});

describe("author deletion", () => {
  it("deleting a coach account nulls author_id/updated_by, keeps the meal, and shows \"Coach\" everywhere", async () => {
    const team = await setupTeam();
    const authored = await createMeal(team.coach, { name: "By coach2" });
    const editedByCoach = await createMeal(team.owner, { name: "Edited by coach2" });
    expect((await api(`/api/coach/meals/${editedByCoach.id}`, { method: "PUT", json: mealBody({ name: "Edited by coach2" }), cookie: team.coach.cookie })).status).toBe(200);
    const untouched = await createMeal(team.owner, { name: "Owner only" });

    const deleted = await api("/api/auth/account", { method: "DELETE", json: { password: DEFAULT_PASSWORD }, cookie: team.coach.cookie });
    expect(deleted.status).toBe(200);

    expect(await env.DB.prepare("SELECT id, author_id, updated_by FROM team_meals ORDER BY id").all().then((r) => r.results)).toEqual([
      { id: authored.id, author_id: null, updated_by: null },
      { id: editedByCoach.id, author_id: team.owner.user.id, updated_by: null },
      { id: untouched.id, author_id: team.owner.user.id, updated_by: null },
    ]);
    const meals = await listMeals(team.owner);
    expect(meals.map((meal) => [meal.name, meal.author, meal.updatedBy])).toEqual([
      ["Owner only", "owner", null], ["Edited by coach2", "owner", "Coach"], ["By coach2", "Coach", null],
    ]);
    const recipes = (await recipesOf(team.athleteA)).recipes;
    expect(recipes.find((recipe) => recipe.key === `team:${authored.id}`)?.author).toBe("Coach");
    // A meal whose author is gone can still be edited and deleted.
    expect((await api(`/api/coach/meals/${authored.id}`, { method: "PUT", json: mealBody({ name: "Adopted" }), cookie: team.owner.cookie })).status).toBe(200);
    expect((await listMeals(team.owner)).find((meal) => meal.id === authored.id)).toMatchObject({ author: "Coach", updatedBy: "owner" });
    expect(await env.DB.prepare("PRAGMA foreign_key_check").all().then((r) => r.results)).toEqual([]);
  });
});

describe("personal export/import", () => {
  interface ExportFile { version: number; data: Record<string, unknown> & { inspirationEntries: Array<{ recipeName: string }> } }

  it("export excludes team meals; import neither creates, duplicates nor deletes them", async () => {
    const team = await setupTeam();
    expect((await api("/api/inspiration", { json: inspirationBody("My own oats"), cookie: team.athleteA.cookie })).status).toBe(200);
    await createMeal(team.owner, { name: "TEAM_MEAL_ONE" });
    await createMeal(team.coach, { name: "TEAM_MEAL_TWO" });
    const mealsBefore = await mealRows();

    const exported = await apiJson<ExportFile>("/api/export", { cookie: team.athleteA.cookie });
    expect(exported.status).toBe(200);
    expect(exported.body.data.inspirationEntries.map((entry) => entry.recipeName)).toEqual(["My own oats"]);
    expect(Object.keys(exported.body.data)).not.toContain("teamMeals");
    expect(JSON.stringify(exported.body)).not.toContain("TEAM_MEAL_");

    // Round trip into the same account and into another athlete.
    for (const target of [team.athleteA, team.athleteB]) {
      const imported = await apiJson("/api/import", { json: exported.body, cookie: target.cookie });
      expect(imported.status).toBe(200);
      expect(await mealRows()).toEqual(mealsBefore);
      const recipes = (await recipesOf(target)).recipes;
      expect(recipes.filter((recipe) => recipe.source === "team").map((recipe) => recipe.name).sort()).toEqual(["TEAM_MEAL_ONE", "TEAM_MEAL_TWO"]);
      expect(recipes.filter((recipe) => recipe.source === "own").map((recipe) => recipe.name)).toEqual(["My own oats"]);
    }

    // A file carrying team meals (as recipes or a teamMeals key) cannot create any.
    const forged = structuredClone(exported.body) as ExportFile & { data: Record<string, unknown> };
    forged.data.teamMeals = [{ id: 99, name: "FORGED", summary: "s", ingredients: "i", instructions: "m" }];
    const forgedResult = await apiJson("/api/import", { json: forged, cookie: team.athleteA.cookie });
    expect([200, 400]).toContain(forgedResult.status);
    expect(await mealRows()).toEqual(mealsBefore);
    expect(JSON.stringify(await recipesOf(team.athleteA))).not.toContain("FORGED");
  });
});
