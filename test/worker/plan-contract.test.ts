import { expect, it } from "vitest";
import { apiJson } from "./helpers";
import { setupAthletes } from "./tracker-fixtures";
type PlannedSessionWrite = { dayKey: string; sessionType: string; detail: string; prescription: string; updatedAt: string };

it("personal and coach plan saves return the declared mutation contract", async () => {
  const { athlete, owner } = await setupAthletes();
  const input = { dayKey: "mon", sessionType: "Practice", detail: "Technique", prescription: "Choose a skill" };
  for (const [path, method, cookie] of [
    ["/api/plan/sessions", "POST", athlete.cookie],
    [`/api/coach/athletes/${athlete.user.id}/plan/sessions`, "PUT", owner.cookie],
  ]) {
    const { status, body } = await apiJson<PlannedSessionWrite>(path!, { method, cookie, json: input });
    expect(status).toBe(200);
    expect(body).toEqual({ ...input, updatedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
  }
});
