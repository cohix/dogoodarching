/**
 * Work item 0001 section 6 (A6): update/delete handlers report 404 when the
 * target id belongs to another user or does not exist, and never touch the
 * row they were not allowed to reach.
 */
import { describe, expect, it } from "vitest";
import { api, apiJson, type Session } from "./helpers";
import { addItem, addScore, addSession, addSetup, checkItem, count, rows, sessionBody, setupAthletes, setupBody, setupSquad } from "./tracker-fixtures";

interface Call { path: string; method: "PUT" | "DELETE" | "POST"; json?: unknown }

interface Mutation {
  name: string;
  error: string;
  /** Creates the target row as `owner` and returns its id. */
  create(owner: Session): Promise<number>;
  /** The mutation under test, aimed at `id`. */
  call(id: number): Call;
  /** Everything stored for `id` (row plus children); must not change on a 404. */
  snapshot(id: number): Promise<unknown>;
  /** Whether a successful call removes the row. */
  deletes: boolean;
}

const mutations: Mutation[] = [
  {
    name: "PUT /api/sessions/:id (session update)",
    error: "Session not found",
    create: (owner) => addSession(owner),
    call: (id) => ({ path: `/api/sessions/${id}`, method: "PUT", json: sessionBody({ arrows: 999, notes: "overwritten", focus: "hijack" }) }),
    snapshot: (id) => rows("SELECT * FROM training_sessions WHERE id = ?", id),
    deletes: false,
  },
  {
    name: "DELETE /api/sessions/:id (session delete)",
    error: "Session not found",
    create: (owner) => addSession(owner),
    call: (id) => ({ path: `/api/sessions/${id}`, method: "DELETE" }),
    snapshot: (id) => rows("SELECT * FROM training_sessions WHERE id = ?", id),
    deletes: true,
  },
  {
    name: "DELETE /api/scores/:id (score delete)",
    error: "Score not found",
    create: (owner) => addScore(owner),
    call: (id) => ({ path: `/api/scores/${id}`, method: "DELETE" }),
    snapshot: async (id) => ({
      score: await rows("SELECT * FROM practice_scores WHERE id = ?", id),
      ends: await rows("SELECT * FROM practice_score_ends WHERE score_id = ? ORDER BY end_number", id),
    }),
    deletes: true,
  },
  {
    name: "PUT /api/maintenance/items/:id (maintenance update)",
    error: "Maintenance item not found",
    create: async (owner) => {
      const id = await addItem(owner, "Weekly", "Wax the string");
      await checkItem(owner, id, true);
      return id;
    },
    call: (id) => ({ path: `/api/maintenance/items/${id}`, method: "PUT", json: { label: "overwritten" } }),
    snapshot: async (id) => ({
      item: await rows("SELECT * FROM maintenance_items WHERE id = ?", id),
      checks: await rows("SELECT * FROM maintenance_checks WHERE key = ? ORDER BY user_id", `item:${id}`),
    }),
    deletes: false,
  },
  {
    name: "DELETE /api/maintenance/items/:id (maintenance delete)",
    error: "Maintenance item not found",
    create: async (owner) => {
      const id = await addItem(owner, "Monthly", "Check limb bolts");
      await checkItem(owner, id, true);
      return id;
    },
    call: (id) => ({ path: `/api/maintenance/items/${id}`, method: "DELETE" }),
    snapshot: async (id) => ({
      item: await rows("SELECT * FROM maintenance_items WHERE id = ?", id),
      checks: await rows("SELECT * FROM maintenance_checks WHERE key = ? ORDER BY user_id", `item:${id}`),
    }),
    deletes: true,
  },
  {
    name: "POST /api/setups with an id (setup save)",
    error: "Setup not found",
    create: (owner) => addSetup(owner),
    call: (id) => ({ path: "/api/setups", method: "POST", json: setupBody({ id, name: "overwritten", poundage: 99 }) }),
    snapshot: (id) => rows("SELECT * FROM bow_setups WHERE id = ?", id),
    deletes: false,
  },
];

const TABLES = ["training_sessions", "practice_scores", "practice_score_ends", "maintenance_items", "maintenance_checks", "bow_setups"];

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) counts[table] = await count(table);
  return counts;
}

function send(call: Call, session: Session): Promise<Response> {
  return api(call.path, { method: call.method, json: call.json, cookie: session.cookie });
}

async function expectNotFound(response: Response, error: string): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error });
}

describe.each(mutations)("$name", (mutation) => {
  it("returns 404 for another athlete's id and leaves the row untouched", async () => {
    const { athlete, rival } = await setupAthletes();
    const id = await mutation.create(athlete);
    const before = await mutation.snapshot(id);
    const countsBefore = await tableCounts();

    await expectNotFound(await send(mutation.call(id), rival), mutation.error);

    expect(await mutation.snapshot(id)).toEqual(before);
    // Nothing was created for the caller either (e.g. a setup "save" must not fall back to insert).
    expect(await tableCounts()).toEqual(countsBefore);
  });

  it("returns 403 when a coach aims the athlete-only route at an athlete's id (0003 §5)", async () => {
    const { owner, coach, athlete } = await setupSquad();
    const id = await mutation.create(athlete);
    const before = await mutation.snapshot(id);
    const countsBefore = await tableCounts();

    for (const session of [owner, coach]) {
      const response = await send(mutation.call(id), session);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
    }

    expect(await mutation.snapshot(id)).toEqual(before);
    expect(await tableCounts()).toEqual(countsBefore);
  });

  it("returns 404 for an id that does not exist", async () => {
    const { athlete } = await setupAthletes();
    // Own data exists, so "no rows at all" is not what produces the 404.
    const id = await mutation.create(athlete);
    const before = await mutation.snapshot(id);
    const countsBefore = await tableCounts();

    await expectNotFound(await send(mutation.call(id + 1000), athlete), mutation.error);

    expect(await mutation.snapshot(id)).toEqual(before);
    expect(await tableCounts()).toEqual(countsBefore);
  });

  it("succeeds for the owner after a rejected foreign attempt, then 404s once the row is gone", async () => {
    const { athlete, rival } = await setupAthletes();
    const id = await mutation.create(athlete);
    await expectNotFound(await send(mutation.call(id), rival), mutation.error);

    const own = await send(mutation.call(id), athlete);
    expect(own.status).toBe(200);
    await own.text();

    if (!mutation.deletes) {
      // Remove the row behind the API's back: the same update now has nothing to match.
      const table = mutation.name.includes("sessions") ? "training_sessions" : mutation.name.includes("maintenance") ? "maintenance_items" : "bow_setups";
      await rows(`DELETE FROM ${table} WHERE id = ?`, id);
    }
    // Double-click delete / update of a deleted row.
    await expectNotFound(await send(mutation.call(id), athlete), mutation.error);
    await expectNotFound(await send(mutation.call(id), athlete), mutation.error);
  });
});

describe("successful mutations still behave as before", () => {
  it("an update that writes identical values matches and returns 200", async () => {
    const { athlete } = await setupAthletes();
    const sessionId = await addSession(athlete);
    const same = await apiJson(`/api/sessions/${sessionId}`, { method: "PUT", json: sessionBody(), cookie: athlete.cookie });
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ ok: true });

    const itemId = await addItem(athlete, "Weekly", "Wax the string");
    const sameLabel = await apiJson(`/api/maintenance/items/${itemId}`, { method: "PUT", json: { label: "Wax the string" }, cookie: athlete.cookie });
    expect(sameLabel.status).toBe(200);

    const setupId = await addSetup(athlete);
    const sameSetup = await apiJson("/api/setups", { json: setupBody({ id: setupId }), cookie: athlete.cookie });
    expect(sameSetup.status).toBe(200);
    expect(sameSetup.body).toEqual({ id: setupId });
    expect(await count("bow_setups")).toBe(1);
  });

  it("the owner's update and delete change exactly the targeted row", async () => {
    const { athlete, rival } = await setupAthletes();
    const mine = await addSession(athlete, { notes: "mine" });
    const other = await addSession(athlete, { notes: "other" });
    const theirs = await addSession(rival, { notes: "theirs" });

    const updated = await apiJson(`/api/sessions/${mine}`, { method: "PUT", json: sessionBody({ notes: "edited", arrows: 72 }), cookie: athlete.cookie });
    expect(updated.status).toBe(200);
    expect(await rows("SELECT id, notes, arrows FROM training_sessions ORDER BY id")).toEqual([
      { id: mine, notes: "edited", arrows: 72 },
      { id: other, notes: "other", arrows: 60 },
      { id: theirs, notes: "theirs", arrows: 60 },
    ]);

    const deleted = await apiJson(`/api/sessions/${mine}`, { method: "DELETE", cookie: athlete.cookie });
    expect(deleted.status).toBe(200);
    expect((await rows<{ id: number }>("SELECT id FROM training_sessions ORDER BY id")).map((row) => row.id)).toEqual([other, theirs]);
  });

  it("deleting a score removes its ends and only its ends", async () => {
    const { athlete, rival } = await setupAthletes();
    const first = await addScore(athlete);
    const second = await addScore(athlete);
    const theirs = await addScore(rival);

    expect((await api(`/api/scores/${first}`, { method: "DELETE", cookie: athlete.cookie })).status).toBe(200);

    expect(await count("practice_score_ends", "score_id = ?", first)).toBe(0);
    expect(await count("practice_score_ends", "score_id = ?", second)).toBe(10);
    expect(await count("practice_score_ends", "score_id = ?", theirs)).toBe(10);
    expect(await count("practice_scores")).toBe(2);
  });

  it("saving a setup without an id still creates one", async () => {
    const { athlete } = await setupAthletes();
    const created = await apiJson<{ id: number }>("/api/setups", { json: setupBody(), cookie: athlete.cookie });
    expect(created.status).toBe(200);
    expect(created.body.id).toBeGreaterThan(0);
    expect(await count("bow_setups", "user_id = ?", athlete.user.id)).toBe(1);
  });
});

describe("ids that are not positive integers", () => {
  it.each(["0", "-1", "1.5", "abc", "1e2x", "9".repeat(30)])("path id %s is rejected with 400 or 404, never 500", async (id) => {
    const { athlete } = await setupAthletes();
    await addSession(athlete);
    const calls: Call[] = [
      { path: `/api/sessions/${id}`, method: "PUT", json: sessionBody() },
      { path: `/api/sessions/${id}`, method: "DELETE" },
      { path: `/api/scores/${id}`, method: "DELETE" },
      { path: `/api/maintenance/items/${id}`, method: "PUT", json: { label: "x" } },
      { path: `/api/maintenance/items/${id}`, method: "DELETE" },
    ];
    for (const call of calls) {
      const response = await send(call, athlete);
      expect([400, 404], `${call.method} ${call.path}`).toContain(response.status);
      expect(await response.json(), `${call.method} ${call.path}`).toHaveProperty("error");
    }
    expect(await count("training_sessions")).toBe(1);
  });

  it.each([0, -3, 1.5, "7"])("setup id %j in the body is a validation error", async (id) => {
    const { athlete } = await setupAthletes();
    const response = await apiJson("/api/setups", { json: setupBody({ id }), cookie: athlete.cookie });
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(await count("bow_setups")).toBe(0);
  });
});
