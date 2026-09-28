import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { api, type PlannedSessionWrite } from "../../frontend/src/api";

afterEach(() => vi.unstubAllGlobals());
it("the plan client sends the documented methods and exposes only the write response", async () => {
  expectTypeOf<Awaited<ReturnType<typeof api.savePlannedSession>>>().toEqualTypeOf<PlannedSessionWrite>();
  expectTypeOf<Awaited<ReturnType<typeof api.coachSavePlannedSession>>>().toEqualTypeOf<PlannedSessionWrite>();
  expectTypeOf<PlannedSessionWrite>().not.toHaveProperty("attachments");
  expectTypeOf<PlannedSessionWrite>().not.toHaveProperty("day");
  const input = { dayKey: "mon" as const, sessionType: "Practice", detail: "Technique", prescription: "Choose a skill" };
  const output = { ...input, updatedAt: "2026-09-28T12:00:00.000Z" };
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(output), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  expect(await api.savePlannedSession(input)).toEqual(output);
  expect(await api.coachSavePlannedSession("athlete", input)).toEqual(output);
  expect(fetch.mock.calls.map(([path, options]) => [path, options.method, JSON.parse(options.body)])).toEqual([
    ["/api/plan/sessions", "POST", input],
    ["/api/coach/athletes/athlete/plan/sessions", "PUT", input],
  ]);
});
