// Coach endpoints: view/edit any athlete's training plans. Coaches can NEVER
// read an athlete's private log rows (sessions, scores, notes, gear,
// maintenance, inspiration); the overview returns only the aggregate subset.

import { Hono } from "hono";
import { getDb } from "../db";
import { actingUserId, rateLimit } from "../lib/rate-limit";
import { dateKeyUtc } from "../lib/dates";
import { jsonError, parsePositiveInt, validateJson, validateQuery } from "../lib/http";
import { authMiddleware, requireCoach, resolveAthlete, type AppBindings } from "../lib/rbac";
import {
  adjustInput, athleteListQuery, cycleWeekPlanInput, plannedSessionInput, plannedSessionLinkInput, todayQuery,
} from "../lib/validation";
import { uploadPlannedSessionFileFor, addPlannedSessionLinkFor, deletePlannedSessionAttachmentFor } from "../services/attachments";
import { getCoachOverview } from "../services/dashboard";
import { adjustScheduleFor, saveCycleWeekPlanFor, savePlannedSessionFor } from "../services/plan";
import { deactivateAthlete, listAthletes, listCoaches, reactivateAthlete } from "../services/team";

const coach = new Hono<AppBindings>();

coach.use("*", authMiddleware, requireCoach);

coach.get("/coaches", async (c) => {
  if (!c.get("user").isOwner) return jsonError(c, 403, "Forbidden");
  return c.json({ coaches: await listCoaches(getDb(c.env.DB)) });
});

// Active athletes by default; `?include=deactivated` adds deactivated ones
// (flagged by `deactivatedAt`) so they can be reactivated.
coach.get("/athletes", validateQuery(athleteListQuery), async (c) => {
  const includeDeactivated = c.req.valid("query").include === "deactivated";
  return c.json({ athletes: await listAthletes(getDb(c.env.DB), { includeDeactivated }) });
});

// Deactivation/reactivation are idempotent; `resolveAthlete` matches athletes
// only (active or not), so a coach id is a 404. Plan routes below keep
// working for deactivated athletes so their history stays viewable.
coach.post("/athletes/:athleteId/deactivate", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  const status = await deactivateAthlete(getDb(c.env.DB), athlete.id);
  if (!status) return jsonError(c, 404, "Athlete not found");
  return c.json(status);
});

coach.post("/athletes/:athleteId/reactivate", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  const status = await reactivateAthlete(getDb(c.env.DB), athlete.id);
  if (!status) return jsonError(c, 404, "Athlete not found");
  return c.json(status);
});

coach.get("/athletes/:athleteId/overview", validateQuery(todayQuery), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  const today = c.req.valid("query").today ?? dateKeyUtc(new Date());
  return c.json(await getCoachOverview(getDb(c.env.DB), athlete.id, today));
});

coach.put("/athletes/:athleteId/plan/sessions", validateJson(plannedSessionInput), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  return c.json(await savePlannedSessionFor(getDb(c.env.DB), athlete.id, c.req.valid("json")));
});

coach.put("/athletes/:athleteId/plan/weeks", validateJson(cycleWeekPlanInput), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  return c.json(await saveCycleWeekPlanFor(getDb(c.env.DB), athlete.id, c.req.valid("json")));
});

coach.post("/athletes/:athleteId/plan/adjust", validateJson(adjustInput), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  return c.json(await adjustScheduleFor(getDb(c.env.DB), athlete.id, c.req.valid("json")));
});

coach.post("/athletes/:athleteId/plan/sessions/links", validateJson(plannedSessionLinkInput), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  return c.json(await addPlannedSessionLinkFor(getDb(c.env.DB), athlete.id, c.req.valid("json")));
});

coach.post("/athletes/:athleteId/plan/sessions/files", rateLimit("upload", actingUserId), async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  return c.json(await uploadPlannedSessionFileFor(getDb(c.env.DB), c.env.ATTACHMENTS, athlete.id, c.get("user").id, c.req.raw));
});

coach.delete("/athletes/:athleteId/plan/attachments/:attachmentId", async (c) => {
  const athlete = await resolveAthlete(c, c.req.param("athleteId"));
  if (!athlete) return jsonError(c, 404, "Athlete not found");
  const attachmentId = parsePositiveInt(c.req.param("attachmentId"));
  if (!attachmentId) return jsonError(c, 400, "Invalid attachment id");
  const deleted = await deletePlannedSessionAttachmentFor(getDb(c.env.DB), c.env.ATTACHMENTS, athlete.id, attachmentId);
  if (!deleted) return jsonError(c, 404, "Attachment not found");
  return c.json({ ok: true });
});

export default coach;
