import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db";
import { addPracticeScoreFor } from "../../src/services/scores";
import { api, apiJson, bootstrapTeam } from "./helpers";

describe("tracker D1 write regressions", () => {
  it("keeps each score with its ten ends and rolls back a failed end insert", async () => {
    const { athlete } = await bootstrapTeam();
    const db = getDb(env.DB);
    const input = { scoreDate: "2026-09-28", ends: Array.from({ length: 10 }, () => [8, 9, 10] as [number, number, number]) };
    const scores = await Promise.all([
      addPracticeScoreFor(db, athlete.user.id, input),
      addPracticeScoreFor(db, athlete.user.id, input),
    ]);
    expect(new Set(scores.map((score) => score.id)).size).toBe(2);
    for (const score of scores) {
      expect(await env.DB.prepare("SELECT count(*) AS n FROM practice_score_ends WHERE score_id = ? AND user_id = ?")
        .bind(score.id, athlete.user.id).first("n")).toBe(10);
    }
    await env.DB.prepare(`CREATE TRIGGER fail_score_end BEFORE INSERT ON practice_score_ends
      WHEN NEW.end_number = 5 BEGIN SELECT RAISE(ABORT, 'forced end failure'); END`).run();
    try {
      await expect(addPracticeScoreFor(db, athlete.user.id, input)).rejects.toThrow();
      expect(await env.DB.prepare("SELECT count(*) AS n FROM practice_scores").first("n")).toBe(2);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM practice_score_ends").first("n")).toBe(20);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_score_end").run();
    }
  });

  it("returns 404 for all six mutations against another user's rows or deleted rows", async () => {
    const { coach, athlete } = await bootstrapTeam();
    const session = { sessionDate: "2026-09-28", sessionType: "Range", customActivity: "", arrows: 30, durationMinutes: 20, focus: "", score: "", notes: "" };
    const setup = {
      poundage: 20, name: "Setup", limbRiser: "", tillerBolts: "", braceHeight: "", stringTwists: "", nockingPoint: "",
      centerShot: "", plunger: "", gripNotes: "", stabilizer: "", clickerPosition: "", bareShaft: "", walkBack: "", arrowsInUse: "", sightMarks: {},
    };
    const sessionRow = await apiJson<{ id: number }>("/api/sessions", { cookie: athlete.cookie, json: session });
    const scoreRow = await apiJson<{ id: number }>("/api/scores", { cookie: athlete.cookie, json: { scoreDate: "2026-09-28", ends: Array.from({ length: 10 }, () => [8, 9, 10]) } });
    const itemRow = await apiJson<{ id: number }>("/api/maintenance/items", { cookie: athlete.cookie, json: { section: "Weekly", label: "Check" } });
    const setupRow = await apiJson<{ id: number }>("/api/setups", { cookie: athlete.cookie, json: setup });
    const mutations = [
      { path: `/api/sessions/${sessionRow.body.id}`, method: "PUT", json: session },
      { path: `/api/sessions/${sessionRow.body.id}`, method: "DELETE" },
      { path: `/api/scores/${scoreRow.body.id}`, method: "DELETE" },
      { path: `/api/maintenance/items/${itemRow.body.id}`, method: "PUT", json: { label: "Changed" } },
      { path: `/api/maintenance/items/${itemRow.body.id}`, method: "DELETE" },
      { path: "/api/setups", method: "POST", json: { ...setup, id: setupRow.body.id } },
    ];
    for (const { path, ...options } of mutations) {
      const response = await api(path, { ...options, cookie: coach.cookie });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toHaveProperty("error");
    }
    // Failed cross-user writes leave all owner mutations usable.
    for (const { path, ...options } of mutations) {
      expect((await api(path, { ...options, cookie: athlete.cookie })).status, path).toBe(200);
    }
    for (const { path, ...options } of mutations.slice(0, 5)) {
      expect((await api(path, { ...options, cookie: athlete.cookie })).status, path).toBe(404);
    }
    await env.DB.prepare("DELETE FROM bow_setups WHERE id = ?").bind(setupRow.body.id).run();
    expect((await api("/api/setups", { cookie: athlete.cookie, json: { ...setup, id: setupRow.body.id } })).status).toBe(404);
  });
});
