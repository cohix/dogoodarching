/**
 * Work item 0001 section 7 (A7): a practice score and its ten ends are written
 * in one atomic batch. A failure anywhere in the ends insert must leave no
 * orphan score row behind, and concurrent writers must never swap ends.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db";
import type { PracticeScoreInput } from "../../src/lib/validation";
import { addPracticeScoreFor } from "../../src/services/scores";
import { api, apiJson } from "./helpers";
import { addScore, count, rows, scoreBody, scoreEnds, setupAthletes, tracker, type End } from "./tracker-fixtures";

const TRIGGER = "test_fail_score_end";

/** Makes the ends insert fail for one end number, the way a constraint or storage error would. */
async function failEnd(endNumber: number): Promise<void> {
  await env.DB.prepare(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON practice_score_ends
    WHEN NEW.end_number = ${endNumber} BEGIN SELECT RAISE(ABORT, 'forced end failure'); END`).run();
}

async function dropTrigger(): Promise<void> {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${TRIGGER}`).run();
}

// Triggers are schema objects: `resetStorage` does not remove them.
afterEach(dropTrigger);

const uniform = (value: number): End[] => Array.from({ length: 10 }, () => [value, value, value] as End);

describe("practice score insert is atomic", () => {
  it.each([1, 5, 10])("a forced failure on end %i leaves no score row and no ends (service)", async (endNumber) => {
    const { athlete } = await setupAthletes();
    await failEnd(endNumber);

    await expect(addPracticeScoreFor(getDb(env.DB), athlete.user.id, scoreBody())).rejects.toThrow();

    expect(await count("practice_scores")).toBe(0);
    expect(await count("practice_score_ends")).toBe(0);
  });

  it("a forced failure over HTTP answers 500 { error } and leaves no orphan score", async () => {
    const { athlete } = await setupAthletes();
    const kept = await addScore(athlete, { scoreDate: "2026-09-01" });
    await failEnd(7);

    const failed = await apiJson("/api/scores", { json: scoreBody({ scoreDate: "2026-09-02" }), cookie: athlete.cookie });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Internal server error" });
    expect(await rows("SELECT id, score_date FROM practice_scores")).toEqual([{ id: kept, score_date: "2026-09-01" }]);
    expect(await count("practice_score_ends")).toBe(10);
    expect(await count("practice_score_ends", "score_id = ?", kept)).toBe(10);
    // The dashboard shows only the score that was fully written.
    const payload = await tracker(athlete, { today: "2026-09-28" });
    expect(payload.practiceScores.map((score) => score.id)).toEqual([kept]);
    expect(payload.practiceScores[0]?.ends).toHaveLength(10);
  });

  it("a constraint failure in the ends insert (NULL arrow) rolls the score back", async () => {
    const { athlete } = await setupAthletes();
    const ends = scoreEnds() as unknown as Array<[number, number, number | null]>;
    (ends[9] as [number, number, number | null])[2] = null;
    const input = { scoreDate: "2026-09-21", ends } as unknown as PracticeScoreInput;

    await expect(addPracticeScoreFor(getDb(env.DB), athlete.user.id, input)).rejects.toThrow();

    expect(await count("practice_scores")).toBe(0);
    expect(await count("practice_score_ends")).toBe(0);
  });

  it("recovers after a failed insert: the next score gets all ten of its own ends", async () => {
    const { athlete } = await setupAthletes();
    await failEnd(3);
    expect((await api("/api/scores", { json: scoreBody(), cookie: athlete.cookie })).status).toBe(500);
    await dropTrigger();

    const created = await apiJson<{ id: number; total: number; averageArrow: number }>("/api/scores", { json: scoreBody({ ends: uniform(9) }), cookie: athlete.cookie });

    expect(created.status).toBe(200);
    expect(created.body.total).toBe(270);
    expect(created.body.averageArrow).toBe(9);
    expect(await rows("SELECT score_id, user_id, count(*) AS n, sum(end_total) AS total FROM practice_score_ends GROUP BY score_id, user_id"))
      .toEqual([{ score_id: created.body.id, user_id: athlete.user.id, n: 10, total: 270 }]);
  });

  it("a failed insert for one athlete does not disturb another athlete's scores", async () => {
    const { athlete, rival } = await setupAthletes();
    const theirs = await addScore(rival, { ends: uniform(4) });
    await failEnd(10);

    expect((await api("/api/scores", { json: scoreBody(), cookie: athlete.cookie })).status).toBe(500);

    expect(await rows("SELECT id, user_id, total FROM practice_scores")).toEqual([{ id: theirs, user_id: rival.user.id, total: 120 }]);
    expect(await count("practice_score_ends", "score_id = ? AND user_id = ?", theirs, rival.user.id)).toBe(10);
  });
});

describe("practice score ends always belong to their own score", () => {
  it("stores the ten ends in order with the submitted arrows and totals", async () => {
    const { athlete } = await setupAthletes();
    const id = await addScore(athlete);

    const stored = await rows<{ end_number: number; arrow_1: number; arrow_2: number; arrow_3: number; end_total: number; user_id: string }>(
      "SELECT end_number, arrow_1, arrow_2, arrow_3, end_total, user_id FROM practice_score_ends WHERE score_id = ? ORDER BY end_number", id);

    expect(stored).toEqual(scoreEnds().map((arrows, index) => ({
      end_number: index + 1, arrow_1: arrows[0], arrow_2: arrows[1], arrow_3: arrows[2],
      end_total: arrows[0] + arrows[1] + arrows[2], user_id: athlete.user.id,
    })));
    const payload = await tracker(athlete, { today: "2026-09-28" });
    expect(payload.practiceScores).toHaveLength(1);
    expect(payload.practiceScores[0]?.ends.map((end) => end.arrows)).toEqual(scoreEnds());
    expect(payload.practiceScores[0]?.total).toBe(scoreEnds().flat().reduce((sum, value) => sum + value, 0));
  });

  it("concurrent inserts by two athletes never mix ends between scores or users", async () => {
    const { athlete, rival } = await setupAthletes();
    // Request k scores every arrow as k, so each score's ends identify the request they came from.
    const requests = [1, 2, 3, 4, 5, 6, 7, 8].map((value) => ({ value, session: value % 2 === 0 ? athlete : rival }));

    const responses = await Promise.all(requests.map(({ value, session }) =>
      apiJson<{ id: number; total: number }>("/api/scores", { json: scoreBody({ ends: uniform(value) }), cookie: session.cookie })));

    expect(responses.map((response) => response.status)).toEqual(requests.map(() => 200));
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(requests.length);
    for (const [index, { value, session }] of requests.entries()) {
      const id = responses[index]?.body.id as number;
      expect(responses[index]?.body.total).toBe(value * 30);
      expect(await rows("SELECT id, user_id, total FROM practice_scores WHERE id = ?", id)).toEqual([{ id, user_id: session.user.id, total: value * 30 }]);
      const ends = await rows<{ user_id: string; end_number: number; arrow_1: number; arrow_2: number; arrow_3: number }>(
        "SELECT user_id, end_number, arrow_1, arrow_2, arrow_3 FROM practice_score_ends WHERE score_id = ? ORDER BY end_number", id);
      expect(ends, `score ${id} (value ${value})`).toEqual(Array.from({ length: 10 }, (_unused, end) => ({
        user_id: session.user.id, end_number: end + 1, arrow_1: value, arrow_2: value, arrow_3: value,
      })));
    }
    expect(await count("practice_score_ends")).toBe(requests.length * 10);
    // Every end's owner matches its score's owner.
    expect(await count("practice_score_ends", "user_id <> (SELECT user_id FROM practice_scores WHERE id = score_id)")).toBe(0);
  });

  it("attaches ends to the new score after the newest score was deleted", async () => {
    const { athlete, rival } = await setupAthletes();
    const first = await addScore(athlete, { ends: uniform(1) });
    const newest = await addScore(rival, { ends: uniform(2) });
    expect((await api(`/api/scores/${newest}`, { method: "DELETE", cookie: rival.cookie })).status).toBe(200);

    const next = await addScore(athlete, { ends: uniform(3) });

    expect(next).toBeGreaterThan(newest);
    expect(await count("practice_score_ends", "score_id = ? AND arrow_1 = 1", first)).toBe(10);
    expect(await count("practice_score_ends", "score_id = ? AND arrow_1 = 3", next)).toBe(10);
    expect(await count("practice_score_ends")).toBe(20);
  });

  it("attaches ends correctly when ids were imported above the sequence", async () => {
    const { athlete } = await setupAthletes();
    // An import writes explicit ids; the next API insert must still find its own row.
    await env.DB.prepare("INSERT INTO practice_scores (id, user_id, score_date, total, created_at) VALUES (?, ?, '2026-01-01', 0, 1)")
      .bind(5000, athlete.user.id).run();

    const next = await addScore(athlete, { ends: uniform(6) });

    expect(next).toBe(5001);
    expect(await count("practice_score_ends", "score_id = 5000")).toBe(0);
    expect(await count("practice_score_ends", "score_id = 5001 AND arrow_2 = 6")).toBe(10);
  });
});

describe("practice score validation rejects before any write", () => {
  it.each([
    ["nine ends", { ends: scoreEnds().slice(0, 9) }],
    ["eleven ends", { ends: [...scoreEnds(), [1, 1, 1]] }],
    ["an arrow above 10", { ends: [...scoreEnds().slice(0, 9), [10, 10, 11]] }],
    ["a negative arrow", { ends: [...scoreEnds().slice(0, 9), [-1, 0, 0]] }],
    ["a fractional arrow", { ends: [...scoreEnds().slice(0, 9), [9.5, 9, 9]] }],
    ["an end with two arrows", { ends: [...scoreEnds().slice(0, 9), [9, 9]] }],
    ["a malformed date", { scoreDate: "21/09/2026" }],
  ])("%s → 400 and nothing stored", async (_label, overrides) => {
    const { athlete } = await setupAthletes();
    const response = await apiJson("/api/scores", { json: scoreBody(overrides), cookie: athlete.cookie });
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(await count("practice_scores")).toBe(0);
    expect(await count("practice_score_ends")).toBe(0);
  });
});
