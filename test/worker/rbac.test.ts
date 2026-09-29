// RBAC matrix across every /api/coach/* route, plus the attachment download rule.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addOwnLink, countRows, filePayload, setupTeam, uploadFileForAthlete, uploadOwnFile, type Team } from "./auth-fixtures";
import { api, apiJson, uploadFile, type RequestOptions, type Session } from "./helpers";
import { addItem, addScore, addSession, addSetup, scoreBody, sessionBody, setupBody } from "./tracker-fixtures";

/** Every coach route. `body` is a valid payload; `setup` creates any row the route needs. */
interface CoachRoute {
  name: string;
  method: string;
  path: (athleteId: string, team: Team, extra: number | undefined) => string;
  body?: Record<string, unknown>;
  ok: number;
  /** Runs once per matrix test, before requests; returns the extra id (attachment) for the athlete. */
  setup?: (team: Team, athleteId: string) => Promise<number>;
}

const ROUTES: CoachRoute[] = [
  { name: "GET /athletes", method: "GET", path: () => "/api/coach/athletes", ok: 200 },
  { name: "GET /athletes/:id/overview", method: "GET", path: (id) => `/api/coach/athletes/${id}/overview`, ok: 200 },
  { name: "GET /athletes/:id/overview?today", method: "GET", path: (id) => `/api/coach/athletes/${id}/overview?today=2026-09-28`, ok: 200 },
  {
    name: "PUT /athletes/:id/plan/sessions", method: "PUT", path: (id) => `/api/coach/athletes/${id}/plan/sessions`,
    body: { dayKey: "mon", sessionType: "Range", detail: "Blank bale", prescription: "60 arrows" }, ok: 200,
  },
  {
    name: "PUT /athletes/:id/plan/weeks", method: "PUT", path: (id) => `/api/coach/athletes/${id}/plan/weeks`,
    body: { weekNumber: 1, primaryFocus: "Release", backgroundFocusOne: "", backgroundFocusTwo: "" }, ok: 200,
  },
  {
    name: "POST /athletes/:id/plan/adjust", method: "POST", path: (id) => `/api/coach/athletes/${id}/plan/adjust`,
    body: { adjustment: "forward", today: "2026-09-28" }, ok: 200,
  },
  {
    name: "POST /athletes/:id/plan/sessions/links", method: "POST", path: (id) => `/api/coach/athletes/${id}/plan/sessions/links`,
    body: { dayKey: "tue", label: "Form video", url: "https://example.org/form" }, ok: 200,
  },
  {
    name: "POST /athletes/:id/plan/sessions/files", method: "POST", path: (id) => `/api/coach/athletes/${id}/plan/sessions/files`,
    body: filePayload(), ok: 200,
  },
  {
    name: "DELETE /athletes/:id/plan/attachments/:attachmentId", method: "DELETE",
    path: (id, _team, extra) => `/api/coach/athletes/${id}/plan/attachments/${extra ?? 1}`, ok: 200,
    setup: (team, athleteId) => uploadFileForAthlete(team.owner, athleteId),
  },
];

function request(route: CoachRoute, path: string, session?: Session): Promise<Response> {
  if (path.endsWith("/files")) return uploadFile(path, session, route.body);
  const options: RequestOptions = { method: route.method, cookie: session?.cookie };
  if (route.body) options.json = route.body;
  return api(path, options);
}

describe("RBAC matrix over /api/coach/*", () => {
  for (const route of ROUTES) {
    it(`${route.name}: athlete 403, anonymous 401, any coach 2xx on any athlete, coach ids 404`, async () => {
      const team = await setupTeam();
      const extraA = route.setup ? await route.setup(team, team.athleteA.user.id) : undefined;
      const extraB = route.setup ? await route.setup(team, team.athleteB.user.id) : undefined;
      const pathA = route.path(team.athleteA.user.id, team, extraA);

      // Athletes: always 403, even on their own id and even with a valid body.
      const athleteOwn = await apiJson<{ error: string }>(pathA, { method: route.method, json: route.body, cookie: team.athleteA.cookie });
      expect(athleteOwn.status, "athlete on own id").toBe(403);
      expect(athleteOwn.body).toEqual({ error: expect.any(String) });
      expect((await request(route, pathA, team.athleteB)).status, "athlete on another athlete").toBe(403);
      // ...and with an invalid body the answer is still 403, not 400 (RBAC runs first).
      if (route.body) {
        expect((await api(pathA, { method: route.method, json: { nonsense: true }, cookie: team.athleteA.cookie })).status, "athlete invalid body").toBe(403);
      }

      // Anonymous and bad cookies: 401.
      expect((await request(route, pathA)).status, "anonymous").toBe(401);
      expect((await request(route, pathA, { cookie: "dga_session=bogus", user: team.owner.user })).status, "bogus cookie").toBe(401);

      // Any coach reaches any athlete: the owner on the athlete invited by the
      // other coach, and the non-owner coach on the athlete invited by the owner.
      const ownerOnB = await request(route, route.path(team.athleteB.user.id, team, extraB), team.owner);
      expect(ownerOnB.status, "owner on athleteB").toBe(route.ok);
      const coachOnA = await request(route, pathA, team.coach);
      expect(coachOnA.status, "non-owner coach on athleteA").toBe(route.ok);

      // Coach endpoints cannot target a coach's account (their own, the owner's, another coach's) or an unknown id.
      for (const [label, id] of [["own coach id", team.coach.user.id], ["owner id", team.owner.user.id], ["unknown id", "00000000-0000-4000-8000-000000000000"]] as const) {
        if (route.name === "GET /athletes") continue; // no id in the path
        const path = route.path(id, team, extraA);
        const result = await apiJson<{ error: string }>(path, { method: route.method, json: route.body, cookie: team.coach.cookie });
        expect(result.status, `coach targeting ${label}`).toBe(404);
        expect(result.body).toEqual({ error: expect.any(String) });
        expect((await request(route, path, team.owner)).status, `owner targeting ${label}`).toBe(404);
      }
    });
  }

  it("GET /api/coach/coaches is owner-only", async () => {
    const team = await setupTeam();
    const ok = await apiJson<{ coaches: Array<{ id: string; username: string; isOwner: boolean; createdAt: string }> }>("/api/coach/coaches", { cookie: team.owner.cookie });
    expect(ok.status).toBe(200);
    expect(ok.body.coaches.map((c) => [c.username, c.isOwner])).toEqual([["coach2", false], ["owner", true]]);
    for (const coach of ok.body.coaches) expect(Object.keys(coach).sort()).toEqual(["createdAt", "id", "isOwner", "username"]);
    expect((await api("/api/coach/coaches", { cookie: team.coach.cookie })).status).toBe(403);
    expect((await api("/api/coach/coaches", { cookie: team.athleteA.cookie })).status).toBe(403);
    expect((await api("/api/coach/coaches")).status).toBe(401);
  });

  it("coach writes land on the targeted athlete only, and never on the coach's own account", async () => {
    const team = await setupTeam();
    expect((await api(`/api/coach/athletes/${team.athleteA.user.id}/plan/sessions`, {
      method: "PUT", json: { dayKey: "wed", sessionType: "Gym", detail: "Strength", prescription: "3x10" }, cookie: team.coach.cookie,
    })).status).toBe(200);
    expect(await countRows("planned_session_overrides", "user_id = ?", team.athleteA.user.id)).toBe(1);
    expect(await countRows("planned_session_overrides", "user_id = ?", team.athleteB.user.id)).toBe(0);
    expect(await countRows("planned_session_overrides", "user_id = ?", team.coach.user.id)).toBe(0);
    const tracker = await apiJson<{ plannedSessions: Array<{ dayKey: string; sessionType: string }> }>("/api/tracker", { cookie: team.athleteA.cookie });
    expect(tracker.body.plannedSessions.find((s) => s.dayKey === "wed")?.sessionType).toBe("Gym");
    const other = await apiJson<{ plannedSessions: Array<{ dayKey: string; sessionType: string }> }>("/api/tracker", { cookie: team.athleteB.cookie });
    expect(other.body.plannedSessions.find((s) => s.dayKey === "wed")?.sessionType).not.toBe("Gym");
  });

  it("the coach overview exposes only plan and aggregate data, never private log rows", async () => {
    const team = await setupTeam();
    // Athlete logs private data.
    expect((await api("/api/sessions", {
      json: { sessionDate: "2026-09-28", sessionType: "Range", customActivity: "", arrows: 120, durationMinutes: 90, focus: "secret focus", score: "", notes: "private notes" },
      cookie: team.athleteA.cookie,
    })).status).toBe(200);
    const { status, body } = await apiJson<Record<string, unknown>>(`/api/coach/athletes/${team.athleteA.user.id}/overview`, { cookie: team.coach.cookie });
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["cycleSummaries", "plannedSessions", "state", "weeklyArrows", "weeklyPlans"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("secret focus");
    expect(text).not.toContain("private notes");
    // Aggregates do reflect the logged arrows.
    expect(text).toContain("120");
  });
});

describe("attachment downloads (GET /api/plan/attachments/:id/file)", () => {
  it("an athlete cannot download another athlete's attachment (404), while the owner and any coach can", async () => {
    const team = await setupTeam();
    const idA = await uploadOwnFile(team.athleteA, { label: "A's notes" });

    const own = await api(`/api/plan/attachments/${idA}/file`, { cookie: team.athleteA.cookie });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("application/pdf");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]));

    const other = await apiJson<{ error: string }>(`/api/plan/attachments/${idA}/file`, { cookie: team.athleteB.cookie });
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: expect.any(String) });

    expect((await api(`/api/plan/attachments/${idA}/file`, { cookie: team.owner.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${idA}/file`, { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${idA}/file`)).status).toBe(401);
  });

  it("a coach-uploaded file for an athlete is downloadable by that athlete and every coach, not by other athletes", async () => {
    const team = await setupTeam();
    const id = await uploadFileForAthlete(team.coach, team.athleteA.user.id);
    expect((await api(`/api/plan/attachments/${id}/file`, { cookie: team.athleteA.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${id}/file`, { cookie: team.owner.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${id}/file`, { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${id}/file`, { cookie: team.athleteB.cookie })).status).toBe(404);
  });

  it("link attachments, unknown ids and bad ids do not serve files", async () => {
    const team = await setupTeam();
    const linkId = await addOwnLink(team.athleteA);
    expect((await api(`/api/plan/attachments/${linkId}/file`, { cookie: team.athleteA.cookie })).status).toBe(404);
    expect((await api(`/api/plan/attachments/${linkId}/file`, { cookie: team.owner.cookie })).status).toBe(404);
    expect((await api(`/api/plan/attachments/999999/file`, { cookie: team.owner.cookie })).status).toBe(404);
    expect((await api(`/api/plan/attachments/abc/file`, { cookie: team.owner.cookie })).status).toBe(400);
    expect((await api(`/api/plan/attachments/0/file`, { cookie: team.owner.cookie })).status).toBe(400);
  });

  it("an athlete cannot delete another athlete's attachment through the athlete route (404) and it stays downloadable", async () => {
    const team = await setupTeam();
    const idA = await uploadOwnFile(team.athleteA);
    expect((await api(`/api/plan/attachments/${idA}`, { method: "DELETE", cookie: team.athleteB.cookie })).status).toBe(404);
    // The athlete-scoped delete route is athlete-only (0003 §5); coaches must use the coach route.
    expect((await api(`/api/plan/attachments/${idA}`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(403);
    expect(await countRows("planned_session_attachments")).toBe(1);
    expect((await api(`/api/plan/attachments/${idA}/file`, { cookie: team.athleteA.cookie })).status).toBe(200);
    // The owner of the attachment can delete it.
    expect((await api(`/api/plan/attachments/${idA}`, { method: "DELETE", cookie: team.athleteA.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${idA}/file`, { cookie: team.athleteA.cookie })).status).toBe(404);
  });

  it("a coach deleting an attachment must name the athlete who owns it", async () => {
    const team = await setupTeam();
    const idA = await uploadOwnFile(team.athleteA);
    // Wrong athlete in the path: 404, nothing deleted.
    expect((await api(`/api/coach/athletes/${team.athleteB.user.id}/plan/attachments/${idA}`, { method: "DELETE", cookie: team.owner.cookie })).status).toBe(404);
    expect(await countRows("planned_session_attachments")).toBe(1);
    expect((await api(`/api/coach/athletes/${team.athleteA.user.id}/plan/attachments/${idA}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
    expect(await countRows("planned_session_attachments")).toBe(0);
    expect((await api(`/api/plan/attachments/${idA}/file`, { cookie: team.athleteA.cookie })).status).toBe(404);
  });
});

/**
 * Every personal (athlete-only) route with a body that is valid for an athlete,
 * so a 403 cannot be a validation error in disguise. Ids point at the athlete's
 * real rows (created in the test) where a route takes one.
 */
function personalRoutes(ids: { session: number; score: number; attachment: number; item: number; setup: number }) {
  return [
    { method: "GET", path: "/api/tracker" },
    { method: "GET", path: "/api/tracker?today=2026-09-28" },
    { method: "POST", path: "/api/notes/weekly", json: { today: "2026-09-28", notes: "coach note" } },
    { method: "POST", path: "/api/sessions", json: sessionBody() },
    { method: "PUT", path: `/api/sessions/${ids.session}`, json: sessionBody() },
    { method: "DELETE", path: `/api/sessions/${ids.session}` },
    { method: "POST", path: "/api/scores", json: scoreBody() },
    { method: "DELETE", path: `/api/scores/${ids.score}` },
    { method: "POST", path: "/api/plan/sessions", json: { dayKey: "mon", sessionType: "Range", detail: "Blank bale", prescription: "60 arrows" } },
    { method: "POST", path: "/api/plan/sessions/links", json: { dayKey: "tue", label: "Video", url: "https://example.org/video" } },
    { method: "POST", path: "/api/plan/sessions/files", upload: true },
    { method: "DELETE", path: `/api/plan/attachments/${ids.attachment}` },
    { method: "POST", path: "/api/plan/weeks", json: { weekNumber: 1, primaryFocus: "Release", backgroundFocusOne: "", backgroundFocusTwo: "" } },
    { method: "POST", path: "/api/plan/adjust", json: { adjustment: "forward", today: "2026-09-28" } },
    { method: "POST", path: "/api/plan/poundage", json: { poundage: 30, today: "2026-09-28" } },
    { method: "POST", path: "/api/checks", json: { group: "milestone", key: "m1", checked: true } },
    { method: "POST", path: "/api/maintenance/items", json: { section: "Weekly", label: "Wax string" } },
    { method: "PUT", path: `/api/maintenance/items/${ids.item}`, json: { label: "Wax string" } },
    { method: "DELETE", path: `/api/maintenance/items/${ids.item}` },
    { method: "POST", path: `/api/maintenance/items/${ids.item}/check`, json: { checked: true } },
    { method: "POST", path: "/api/maintenance/sections/clear", json: { section: "Weekly" } },
    { method: "POST", path: "/api/setups", json: setupBody() },
    { method: "POST", path: "/api/setups", json: setupBody({ id: ids.setup }) },
    { method: "POST", path: `/api/setups/${ids.setup}/duplicate`, json: { poundage: 30 } },
    { method: "POST", path: "/api/inspiration", json: { thoughtText: "t", videoTitle: "v", videoUrl: "https://example.org/v", recipeName: "r", recipeSummary: "s", recipeIngredients: "i", recipeInstructions: "m" } },
    { method: "GET", path: "/api/export" },
    { method: "POST", path: "/api/import", json: { version: 1 } },
  ] as Array<{ method: string; path: string; json?: unknown; upload?: boolean }>;
}

const PERSONAL_TABLES = ["training_sessions", "practice_scores", "practice_score_ends", "planned_session_overrides", "planned_session_attachments",
  "cycle_week_plans", "program_state", "milestone_checks", "maintenance_items", "maintenance_checks", "bow_setups", "inspiration_entries",
  "weekly_notes", "upload_reservations"];

async function seedAthleteRows(athlete: Session) {
  return {
    session: await addSession(athlete),
    score: await addScore(athlete),
    attachment: await uploadOwnFile(athlete),
    item: await addItem(athlete, "Weekly", "Check nocks"),
    setup: await addSetup(athlete),
  };
}

describe("personal routes are athlete-only (0003 §5)", () => {
  it("every coach (owner or not) gets 403, never 500, on every personal tracker route and on export/import, and nothing is written", async () => {
    const team = await setupTeam();
    const ids = await seedAthleteRows(team.athleteA);
    const before = await Promise.all(PERSONAL_TABLES.map((table) => countRows(table)));
    const objects = (await env.ATTACHMENTS.list()).objects.length;
    for (const coach of [team.owner, team.coach]) {
      for (const route of personalRoutes(ids)) {
        const result = route.upload
          ? await uploadFile(route.path, coach, filePayload())
          : await api(route.path, { method: route.method, json: route.json, cookie: coach.cookie });
        expect(result.status, `${coach.user.username} ${route.method} ${route.path}`).toBe(403);
        expect(await result.json()).toEqual({ error: "Forbidden" });
      }
    }
    expect(await Promise.all(PERSONAL_TABLES.map((table) => countRows(table)))).toEqual(before);
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(objects);
    for (const table of PERSONAL_TABLES) {
      expect(await countRows(table, "user_id IN (?, ?)", team.owner.user.id, team.coach.user.id), table).toBe(0);
    }
    // The athlete's own rows are intact and readable.
    const athleteView = await apiJson<{ sessions: unknown[]; setups: unknown[] }>("/api/tracker", { cookie: team.athleteA.cookie });
    expect(athleteView.status).toBe(200);
    expect(athleteView.body.sessions).toHaveLength(1);
    expect(athleteView.body.setups).toHaveLength(1);
  });

  it("the same bodies succeed for the athlete, so the coach 403 is not a validation error", async () => {
    const team = await setupTeam();
    const ids = await seedAthleteRows(team.athleteA);
    // Deletes and the import (which needs a full payload) are covered elsewhere;
    // every other request must be accepted for the athlete.
    for (const route of personalRoutes(ids).filter((r) => r.method !== "DELETE" && r.path !== "/api/import")) {
      const result = route.upload
        ? await uploadFile(route.path, team.athleteA, filePayload())
        : await api(route.path, { method: route.method, json: route.json, cookie: team.athleteA.cookie });
      expect(result.status, `athlete ${route.method} ${route.path}`).toBe(200);
    }
  });

  it("the 403 runs before validation: an invalid body or id from a stale coach client still gets 403", async () => {
    const team = await setupTeam();
    const ids = { session: 0, score: 0, attachment: 0, item: 0, setup: 0 };
    for (const route of personalRoutes(ids).filter((r) => r.method !== "GET")) {
      const path = route.path.replace("/0", "/not-a-number");
      const result = route.upload
        ? await api(path, { method: "POST", body: "not a file", headers: { "content-type": "text/plain" }, cookie: team.coach.cookie })
        : await api(path, { method: route.method, json: { nonsense: true }, cookie: team.coach.cookie });
      expect(result.status, `${route.method} ${path}`).toBe(403);
    }
    expect((await api("/api/tracker?today=nope", { cookie: team.coach.cookie })).status).toBe(403);
  });

  it("anonymous callers still get 401, and unknown /api paths still 404 for a coach", async () => {
    const team = await setupTeam();
    expect((await api("/api/does-not-exist", { cookie: team.coach.cookie })).status).toBe(404);
    for (const route of personalRoutes({ session: 1, score: 1, attachment: 1, item: 1, setup: 1 })) {
      expect((await api(route.path, { method: route.method, json: route.json })).status, `anonymous ${route.method} ${route.path}`).toBe(401);
    }
  });

  it("coach writes into athlete plans still succeed and land under the athlete", async () => {
    const team = await setupTeam();
    const athleteId = team.athleteA.user.id;
    expect((await api(`/api/coach/athletes/${athleteId}/plan/sessions`, {
      method: "PUT", json: { dayKey: "mon", sessionType: "Range", detail: "Coach detail", prescription: "90 arrows" }, cookie: team.coach.cookie,
    })).status).toBe(200);
    expect((await api(`/api/coach/athletes/${athleteId}/plan/weeks`, {
      method: "PUT", json: { weekNumber: 1, primaryFocus: "Coach focus", backgroundFocusOne: "", backgroundFocusTwo: "" }, cookie: team.owner.cookie,
    })).status).toBe(200);
    expect((await api(`/api/coach/athletes/${athleteId}/plan/adjust`, {
      json: { adjustment: "forward", today: "2026-09-28" }, cookie: team.owner.cookie,
    })).status).toBe(200);
    expect((await api(`/api/coach/athletes/${athleteId}/plan/sessions/links`, {
      json: { dayKey: "tue", label: "Coach link", url: "https://example.org/c" }, cookie: team.coach.cookie,
    })).status).toBe(200);
    const fileId = await uploadFileForAthlete(team.owner, athleteId);
    // Coaches still download athlete plan files through the shared (ungated) route.
    expect((await api(`/api/plan/attachments/${fileId}/file`, { cookie: team.coach.cookie })).status).toBe(200);
    expect((await api(`/api/plan/attachments/${fileId}/file`, { cookie: team.athleteA.cookie })).status).toBe(200);
    expect(await countRows("planned_session_attachments", "user_id = ?", athleteId)).toBe(2);
    expect(await countRows("planned_session_overrides", "user_id = ?", athleteId)).toBe(1);
    expect(await countRows("cycle_week_plans", "user_id = ?", athleteId)).toBe(1);
    expect(await countRows("program_state", "user_id = ?", athleteId)).toBe(1);
    for (const table of PERSONAL_TABLES) {
      expect(await countRows(table, "user_id IN (?, ?)", team.owner.user.id, team.coach.user.id), table).toBe(0);
    }
    // The coach can delete the file they uploaded through the coach route.
    expect((await api(`/api/coach/athletes/${athleteId}/plan/attachments/${fileId}`, { method: "DELETE", cookie: team.coach.cookie })).status).toBe(200);
  });
});
