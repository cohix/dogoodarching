// Coach endpoints: view/edit an athlete's training plans. Coaches can NEVER
// read an athlete's private log rows (sessions, scores, notes, gear,
// maintenance, inspiration) — the overview returns only the aggregate subset.

import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { authMiddleware, requireCoach, resolveAthlete, type AppBindings } from "../lib/rbac";
import {
  addPlannedSessionFileFor,
  addPlannedSessionLinkFor,
  adjustInput,
  adjustScheduleFor,
  cycleWeekPlanInput,
  dateInput,
  deletePlannedSessionAttachmentFor,
  getTrackerPayload,
  plannedSessionFileInput,
  plannedSessionInput,
  plannedSessionLinkInput,
  readJsonBody,
  saveCycleWeekPlanFor,
  savePlannedSessionFor,
  zodErrorMessage,
} from "./tracker";

const coach = new Hono<AppBindings>();

coach.use("*", authMiddleware, requireCoach);

function parsePositiveInt(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

coach.get("/athletes", async (c) => {
  const rows = await getDb(c.env.DB)
    .select({ id: schema.users.id, username: schema.users.username, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(and(eq(schema.users.role, "athlete"), eq(schema.users.coachId, c.get("user").id)))
    .orderBy(asc(schema.users.username));
  return c.json({
    athletes: rows.map((row) => ({ id: row.id, username: row.username, createdAt: row.createdAt.toISOString() })),
  });
});

coach.get("/athletes/:athleteId/overview", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  const parsed = dateInput.optional().safeParse(c.req.query("today") ?? undefined);
  if (!parsed.success) return c.json({ error: "Invalid today parameter" }, 400);
  const today = parsed.data ?? new Date().toISOString().slice(0, 10);
  const payload = await getTrackerPayload(getDb(c.env.DB), athlete.id, today);
  // RBAC: only the aggregate subset leaves this endpoint — never sessions,
  // practice scores, weekly notes, setups, maintenance, or inspiration.
  return c.json({
    state: payload.state,
    weeklyPlans: payload.weeklyPlans,
    plannedSessions: payload.plannedSessions,
    weeklyArrows: payload.weeklyArrows,
    cycleSummaries: payload.cycleSummaries,
  });
});

coach.put("/athletes/:athleteId/plan/sessions", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await savePlannedSessionFor(getDb(c.env.DB), athlete.id, parsed.data));
});

coach.put("/athletes/:athleteId/plan/weeks", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = cycleWeekPlanInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await saveCycleWeekPlanFor(getDb(c.env.DB), athlete.id, parsed.data));
});

coach.post("/athletes/:athleteId/plan/adjust", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = adjustInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await adjustScheduleFor(getDb(c.env.DB), athlete.id, parsed.data));
});

coach.post("/athletes/:athleteId/plan/sessions/links", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionLinkInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  return c.json(await addPlannedSessionLinkFor(getDb(c.env.DB), athlete.id, parsed.data));
});

coach.post("/athletes/:athleteId/plan/sessions/files", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  let body: unknown;
  try { body = await readJsonBody(c); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = plannedSessionFileInput.safeParse(body);
  if (!parsed.success) return c.json({ error: zodErrorMessage(parsed.error) }, 400);
  try {
    return c.json(await addPlannedSessionFileFor(c.env, getDb(c.env.DB), athlete.id, parsed.data));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Upload failed" }, 400);
  }
});

coach.delete("/athletes/:athleteId/plan/attachments/:attachmentId", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return c.json({ error: "Athlete not found" }, 404);
  const attachmentId = parsePositiveInt(c.req.param("attachmentId"));
  if (!attachmentId) return c.json({ error: "Invalid attachment id" }, 400);
  const deleted = await deletePlannedSessionAttachmentFor(c.env, getDb(c.env.DB), athlete.id, attachmentId);
  if (!deleted) return c.json({ error: "Attachment not found" }, 404);
  return c.json({ ok: true });
});

export default coach;
