// The shared coaching team (§13): one deployment is one team. Every coach sees
// and edits every athlete; the owner is the only one who can invite coaches.
import { describe, expect, it } from "vitest";
import { deleteUser, overview, setupTeam, uploadFileForAthlete } from "./auth-fixtures";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite } from "./helpers";

type Roster = { athletes: Array<{ id: string; username: string; createdAt: string; deactivatedAt: string | null }> };

describe("team model", () => {
  it("GET /api/coach/athletes returns every athlete for every coach, regardless of who invited them", async () => {
    const team = await setupTeam();
    const forOwner = await apiJson<Roster>("/api/coach/athletes", { cookie: team.owner.cookie });
    const forCoach = await apiJson<Roster>("/api/coach/athletes", { cookie: team.coach.cookie });
    expect(forOwner.status).toBe(200);
    expect(forCoach.status).toBe(200);
    expect(forOwner.body.athletes.map((a) => a.username)).toEqual(["athleteA", "athleteB"]); // sorted by username
    expect(forCoach.body).toEqual(forOwner.body);
    for (const athlete of forOwner.body.athletes) {
      expect(Object.keys(athlete).sort()).toEqual(["createdAt", "deactivatedAt", "id", "username"]);
      expect(athlete.deactivatedAt).toBeNull();
      expect(athlete).not.toHaveProperty("coachId");
    }
    // Coaches never appear in the athlete roster.
    expect(forOwner.body.athletes.map((a) => a.id)).not.toContain(team.coach.user.id);
    expect(forOwner.body.athletes.map((a) => a.id)).not.toContain(team.owner.user.id);
  });

  it("two coaches both see and can edit the same athlete's plan, and the athlete sees the result", async () => {
    const team = await setupTeam();
    const athleteId = team.athleteA.user.id;

    // Both coaches see the same starting overview.
    const initialOwner = await overview(team.owner, athleteId);
    const initialCoach = await overview(team.coach, athleteId);
    expect(initialCoach).toEqual(initialOwner);
    expect(initialOwner.plannedSessions.map((s) => s.dayKey)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(initialOwner.plannedSessions.every((s) => s.updatedAt === null)).toBe(true);

    // Non-owner coach edits Monday.
    const mondayEdit = await apiJson<{ dayKey: string; sessionType: string; detail: string; prescription: string; updatedAt: string }>(
      `/api/coach/athletes/${athleteId}/plan/sessions`,
      { method: "PUT", json: { dayKey: "mon", sessionType: "Range", detail: "Blank bale", prescription: "60 arrows at 5m" }, cookie: team.coach.cookie },
    );
    expect(mondayEdit.status).toBe(200);
    expect(mondayEdit.body).toMatchObject({ dayKey: "mon", sessionType: "Range", detail: "Blank bale", prescription: "60 arrows at 5m" });

    // Owner sees it, then edits Tuesday and a cycle week.
    const afterCoachEdit = await overview(team.owner, athleteId);
    expect(afterCoachEdit.plannedSessions.find((s) => s.dayKey === "mon")).toMatchObject({ sessionType: "Range", detail: "Blank bale", updatedAt: mondayEdit.body.updatedAt });
    expect((await api(`/api/coach/athletes/${athleteId}/plan/sessions`, {
      method: "PUT", json: { dayKey: "tue", sessionType: "Gym", detail: "Strength", prescription: "Full body" }, cookie: team.owner.cookie,
    })).status).toBe(200);
    expect((await api(`/api/coach/athletes/${athleteId}/plan/weeks`, {
      method: "PUT", json: { weekNumber: 2, primaryFocus: "Anchor", backgroundFocusOne: "Breathing", backgroundFocusTwo: "" }, cookie: team.owner.cookie,
    })).status).toBe(200);

    // The other coach overwrites Monday again; last write wins for everyone.
    expect((await api(`/api/coach/athletes/${athleteId}/plan/sessions`, {
      method: "PUT", json: { dayKey: "mon", sessionType: "SPT", detail: "Holding", prescription: "10 x 30s" }, cookie: team.coach.cookie,
    })).status).toBe(200);

    const finalOwner = await overview(team.owner, athleteId);
    const finalCoach = await overview(team.coach, athleteId);
    expect(finalCoach).toEqual(finalOwner);
    expect(finalOwner.plannedSessions.find((s) => s.dayKey === "mon")).toMatchObject({ sessionType: "SPT", detail: "Holding", prescription: "10 x 30s" });
    expect(finalOwner.plannedSessions.find((s) => s.dayKey === "tue")).toMatchObject({ sessionType: "Gym", detail: "Strength" });
    expect(finalOwner.weeklyPlans).toEqual([expect.objectContaining({ weekNumber: 2, primaryFocus: "Anchor", backgroundFocusOne: "Breathing" })]);

    // The athlete sees exactly the same plan in their own tracker payload.
    const tracker = await apiJson<{ plannedSessions: typeof finalOwner.plannedSessions; weeklyPlans: typeof finalOwner.weeklyPlans }>("/api/tracker", { cookie: team.athleteA.cookie });
    expect(tracker.status).toBe(200);
    expect(tracker.body.plannedSessions).toEqual(finalOwner.plannedSessions);
    expect(tracker.body.weeklyPlans).toEqual(finalOwner.weeklyPlans);

    // The other athlete is untouched.
    const otherTracker = await apiJson<{ plannedSessions: typeof finalOwner.plannedSessions; weeklyPlans: unknown[] }>("/api/tracker", { cookie: team.athleteB.cookie });
    expect(otherTracker.body.plannedSessions.every((s) => s.updatedAt === null)).toBe(true);
    expect(otherTracker.body.weeklyPlans).toEqual([]);
  });

  it("attachments and schedule adjustments made by one coach are visible to the other and to the athlete", async () => {
    const team = await setupTeam();
    const athleteId = team.athleteB.user.id; // invited by the non-owner coach
    const fileId = await uploadFileForAthlete(team.owner, athleteId, { dayKey: "wed", label: "Owner's sheet" });
    const link = await apiJson<{ id: number }>(`/api/coach/athletes/${athleteId}/plan/sessions/links`, {
      json: { dayKey: "wed", label: "Coach's video", url: "https://example.org/v" }, cookie: team.coach.cookie,
    });
    expect(link.status).toBe(200);

    const seenByCoach = await overview(team.coach, athleteId);
    const wed = seenByCoach.plannedSessions.find((s) => s.dayKey === "wed")!;
    expect(wed.attachments.map((a) => [a.id, a.kind, a.label, a.url])).toEqual(expect.arrayContaining([
      [fileId, "document", "Owner's sheet", `/api/plan/attachments/${fileId}/file`],
      [link.body.id, "link", "Coach's video", "https://example.org/v"],
    ]));
    expect((await overview(team.owner, athleteId)).plannedSessions.find((s) => s.dayKey === "wed")).toEqual(wed);

    // Adjust by the non-owner coach; the owner reads the new state.
    const adjusted = await apiJson<{ currentCycle: number; currentWeek: number; adjustment: string }>(`/api/coach/athletes/${athleteId}/plan/adjust`, {
      json: { adjustment: "forward", today: "2026-09-28" }, cookie: team.coach.cookie,
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body).toEqual({ currentCycle: 1, currentWeek: 2, adjustment: "forward" });
    const ownerView = await apiJson<{ state: { currentCycle: number; currentWeek: number } }>(`/api/coach/athletes/${athleteId}/overview?today=2026-09-28`, { cookie: team.owner.cookie });
    expect(ownerView.body.state).toMatchObject({ currentCycle: 1, currentWeek: 2 });
    const athleteView = await apiJson<{ state: { currentCycle: number; currentWeek: number } }>("/api/tracker?today=2026-09-28", { cookie: team.athleteB.cookie });
    expect(athleteView.body.state).toMatchObject({ currentCycle: 1, currentWeek: 2 });
    // The other coach can delete the owner's file.
    expect((await api(`/api/coach/athletes/${athleteId}/plan/attachments/${fileId}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
    expect((await overview(team.owner, athleteId)).plannedSessions.find((s) => s.dayKey === "wed")!.attachments.map((a) => a.id)).toEqual([link.body.id]);
  });

  it("athletes stay on the team when the coach who invited them is deleted", async () => {
    const team = await setupTeam();
    await deleteUser(team.coach.user.id);
    const roster = await apiJson<Roster>("/api/coach/athletes", { cookie: team.owner.cookie });
    expect(roster.body.athletes.map((a) => a.username)).toEqual(["athleteA", "athleteB"]);
    expect((await api(`/api/coach/athletes/${team.athleteB.user.id}/overview`, { cookie: team.owner.cookie })).status).toBe(200);
    expect((await api("/api/tracker", { cookie: team.athleteB.cookie })).status).toBe(200);
  });

  it("a coach invited by the owner can immediately invite athletes who join the same team", async () => {
    const owner = await bootstrapCoach("owner");
    const coach = await acceptInvite(await createInvite(owner, { role: "coach" }), "coach2");
    const athlete = await acceptInvite(await createInvite(coach), "athlete-of-coach2");
    expect(athlete.user.role).toBe("athlete");
    const ownerRoster = await apiJson<Roster>("/api/coach/athletes", { cookie: owner.cookie });
    expect(ownerRoster.body.athletes.map((a) => a.id)).toEqual([athlete.user.id]);
    expect((await api(`/api/coach/athletes/${athlete.user.id}/overview`, { cookie: owner.cookie })).status).toBe(200);
  });

  it("there is exactly one owner and coaches are listed to the owner with their flags", async () => {
    const team = await setupTeam();
    const coaches = await apiJson<{ coaches: Array<{ id: string; isOwner: boolean }> }>("/api/coach/coaches", { cookie: team.owner.cookie });
    expect(coaches.body.coaches.filter((c) => c.isOwner).map((c) => c.id)).toEqual([team.owner.user.id]);
    expect(coaches.body.coaches.map((c) => c.id).sort()).toEqual([team.owner.user.id, team.coach.user.id].sort());
  });
});
