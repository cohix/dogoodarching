import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { count, countedRequest, seedScores, seedSessions, setProgramState, setupAthletes, type Tracker } from "./tracker-fixtures";

it("keeps dashboard queries and fetched rows bounded at 5,000 sessions and 1,000 scores", async () => {
  const { athlete } = await setupAthletes();
  await setProgramState(athlete.user.id, { poundage: 24, cycle: 1, week: 1, anchor: "2026-09-21" });
  await seedSessions(athlete.user.id, Array.from({ length: 100 }, () => ({ sessionDate: "2026-09-21", arrows: 30 })));
  await seedScores(athlete.user.id, Array(100).fill("2026-09-21"));
  const request = () => countedRequest("/api/tracker?today=2026-09-21", athlete.cookie);
  const measure = async () => {
    const warm = await request();
    await warm.response.arrayBuffer();
    const times: number[] = [];
    let sample;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await request();
      expect(result.response.status).toBe(200);
      const payload = await result.response.json() as Tracker;
      times.push(performance.now() - start);
      sample = { ...result, payload };
    }
    return { ...sample!, medianMs: times.sort((a, b) => a - b)[2]! };
  };
  const small = await measure();
  await seedSessions(athlete.user.id, Array.from({ length: 4900 }, () => ({ sessionDate: "2020-01-01", arrows: 99 })));
  await env.DB.prepare("DELETE FROM practice_scores WHERE user_id = ?").bind(athlete.user.id).run();
  await seedScores(athlete.user.id, [...Array(100).fill("2026-09-21"), ...Array(900).fill("2020-01-01")]);
  expect(await count("training_sessions", "user_id = ?", athlete.user.id)).toBe(5000);
  expect(await count("practice_scores", "user_id = ?", athlete.user.id)).toBe(1000);
  expect(await count("practice_score_ends", "user_id = ?", athlete.user.id)).toBe(10000);
  const large = await measure();
  expect(large.statements.length).toBe(small.statements.length);
  for (const sample of [small, large]) {
    expect(sample.payload.sessions).toHaveLength(100);
    expect(sample.payload.practiceScores).toHaveLength(100);
    expect(sample.payload.practiceScores.flatMap(score => score.ends)).toHaveLength(1000);
    expect(sample.payload.weeklyArrows).toEqual([{ week: "2026-W39", arrows: 3000 }]);
    const auth = sample.queries.filter(q => /from "sessions"/.test(q.sql));
    expect(auth).toHaveLength(1);
    expect(auth[0]!.sql).toContain('inner join "users"');
    expect(sample.queries.filter(q => /from "users"/.test(q.sql))).toHaveLength(0);
    const training = sample.queries.filter(q => /from "training_sessions"/.test(q.sql));
    expect(training).toHaveLength(3);
    const grouped = training.find(q => q.sql.includes("group by"))!;
    const distinct = training.find(q => q.sql.startsWith("select distinct"))!;
    expect(grouped).toBeDefined();
    expect(distinct).toBeDefined();
    for (const aggregate of [grouped, distinct]) {
      expect(aggregate.sql).toMatch(/"session_date" >= \?/);
      expect(aggregate.sql).toMatch(/"session_date" < \?/);
      expect(aggregate.params).toEqual([athlete.user.id, "2026-09-21", "2026-11-02"]);
      expect(aggregate.rows).toBe(1);
    }
    const logs = training.filter(q => q !== grouped && q !== distinct);
    expect(logs[0]!.rows).toBe(100);
    expect(logs[0]!.sql).toMatch(/limit \?/);
    const ends = sample.queries.filter(q => /from "practice_score_ends"/.test(q.sql));
    expect(ends).toHaveLength(2);
    const selectedIds = sample.payload.practiceScores.map(score => score.id).sort((a, b) => a - b);
    expect(ends.flatMap(q => q.params.slice(1)).sort((a, b) => Number(a) - Number(b))).toEqual(selectedIds);
    for (const query of ends) {
      expect(query.sql).toMatch(/"score_id" in \(/);
      expect(query.params[0]).toBe(athlete.user.id);
      expect(query.params.length).toBeLessThanOrEqual(51);
      expect(query.rows).toBeLessThanOrEqual(500);
    }
  }
  // Local workerd timings vary with concurrent CI jobs. The SQL/row assertions
  // enforce the bound; this warmed median catches gross latency regressions.
  expect(large.medianMs).toBeLessThan(small.medianMs * 4 + 100);
  console.info(JSON.stringify({ performanceSmoke: { smallMs: small.medianMs, largeMs: large.medianMs, statements: large.statements.length } }));
});
