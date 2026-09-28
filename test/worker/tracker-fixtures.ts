/**
 * Fixtures for the tracker / service / transfer / performance tests.
 * Extends `helpers.ts` without modifying it. Owned by the `tests-tracker` step.
 */
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { acceptInvite, apiJson, bootstrapCoach, createInvite, BASE_URL, type Session } from "./helpers";

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface Squad {
  /** Bootstrap coach (owner). */
  owner: Session;
  /** Second, non-owner coach. */
  coach: Session;
  /** The athlete whose rows are under test. */
  athlete: Session;
  /** Another athlete on the same team: must never reach `athlete`'s rows. */
  rival: Session;
}

/** Owner + non-owner coach + two athletes. Four PBKDF2 hashes, so use it once per test. */
export async function setupSquad(): Promise<Squad> {
  const owner = await bootstrapCoach("owner");
  const coach = await acceptInvite(await createInvite(owner, { role: "coach" }), "coach2");
  const athlete = await acceptInvite(await createInvite(owner), "archer");
  const rival = await acceptInvite(await createInvite(coach), "rival");
  return { owner, coach, athlete, rival };
}

/** Owner + two athletes (no second coach); cheaper than `setupSquad`. */
export async function setupAthletes(): Promise<{ owner: Session; athlete: Session; rival: Session }> {
  const owner = await bootstrapCoach("owner");
  const athlete = await acceptInvite(await createInvite(owner), "archer");
  const rival = await acceptInvite(await createInvite(owner), "rival");
  return { owner, athlete, rival };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export function sessionBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionDate: "2026-09-21", sessionType: "Range", customActivity: "", arrows: 60, durationMinutes: 45,
    focus: "Release", score: "", notes: "Felt steady", ...overrides,
  };
}

export type End = [number, number, number];

/** Ten ends; end n is [n-1, n-1, n] capped at 10, so every end is distinguishable. */
export function scoreEnds(): End[] {
  return Array.from({ length: 10 }, (_unused, index) => [index, index, Math.min(10, index + 1)] as End);
}

export function scoreBody(overrides: Record<string, unknown> = {}) {
  return { scoreDate: "2026-09-21", ends: scoreEnds(), ...overrides };
}

export function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    poundage: 24, name: "Indoor", limbRiser: "25in riser", tillerBolts: "", braceHeight: "8.5in", stringTwists: "",
    nockingPoint: "", centerShot: "", plunger: "", gripNotes: "", stabilizer: "", clickerPosition: "", bareShaft: "",
    walkBack: "", arrowsInUse: "", sightMarks: { "18m": "4.2" }, ...overrides,
  };
}

/** "%PDF-1.4\n" */
export const FILE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
export const FILE_BASE64 = btoa(String.fromCharCode(...FILE_BYTES));

export function fileBody(overrides: Record<string, unknown> = {}) {
  return { dayKey: "wed", kind: "document", label: "Plan notes", mimeType: "application/pdf", dataBase64: FILE_BASE64, ...overrides };
}

// ---------------------------------------------------------------------------
// API shortcuts (throw with status + body when the call does not succeed)
// ---------------------------------------------------------------------------

export async function post<T = { id: number }>(session: Session, path: string, json: unknown): Promise<T> {
  const { status, body } = await apiJson<T>(path, { json, cookie: session.cookie });
  if (status !== 200) throw new Error(`POST ${path} failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

export const addSession = async (session: Session, overrides: Record<string, unknown> = {}) =>
  (await post(session, "/api/sessions", sessionBody(overrides))).id;
export const addScore = async (session: Session, overrides: Record<string, unknown> = {}) =>
  (await post(session, "/api/scores", scoreBody(overrides))).id;
export const addItem = async (session: Session, section: "Weekly" | "Monthly" | "Quarterly", label: string) =>
  (await post(session, "/api/maintenance/items", { section, label })).id;
export const addSetup = async (session: Session, overrides: Record<string, unknown> = {}) =>
  (await post(session, "/api/setups", setupBody(overrides))).id;
export const checkItem = (session: Session, id: number, checked: boolean) =>
  post<{ ok: true }>(session, `/api/maintenance/items/${id}/check`, { checked });

export interface TrackerSession {
  id: number; sessionDate: string; sessionType: string; customActivity: string; arrows: number;
  durationMinutes: number; focus: string; score: string; notes: string; createdAt: string;
}

export interface Tracker {
  state: { currentPoundage: number | null; currentCycle: number; currentWeek: number };
  weeklyPlans: Array<{ weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string; updatedAt: string }>;
  plannedSessions: Array<{
    dayKey: string; day: string; short: string; sessionType: string; detail: string; prescription: string; updatedAt: string | null;
    attachments: Array<{ id: number; dayKey: string; kind: string; label: string; url: string; mimeType: string; createdAt: string }>;
  }>;
  sessions: TrackerSession[];
  practiceScores: Array<{
    id: number; scoreDate: string; total: number; averageArrow: number; averageEnd: number; createdAt: string;
    ends: Array<{ endNumber: number; arrows: [number, number, number]; total: number; averageArrow: number }>;
  }>;
  weeklyArrows: Array<{ week: string; arrows: number }>;
  cycleSummaries: Array<{ cycle: number; weeks: Array<{ weekNumber: number; weekStart: string; arrows: number; dayStatuses: string[] }> }>;
  maintenanceChecks: Record<string, boolean>;
  maintenanceItems: Array<{ id: number; section: string; label: string; checked: boolean }>;
  setups: Array<{ id: number; poundage: number; name: string; limbRiser: string; sightMarks: Record<string, string> }>;
  [key: string]: unknown;
}

export function trackerPath(query: { today?: string; before?: string } = {}): string {
  const params = new URLSearchParams();
  if (query.today) params.set("today", query.today);
  if (query.before) params.set("before", query.before);
  const text = params.toString();
  return text ? `/api/tracker?${text}` : "/api/tracker";
}

export async function tracker(session: Session, query: { today?: string; before?: string } = {}): Promise<Tracker> {
  const path = trackerPath(query);
  const { status, body } = await apiJson<Tracker>(path, { cookie: session.cookie });
  if (status !== 200) throw new Error(`GET ${path} failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------
// Direct D1 access
// ---------------------------------------------------------------------------

export async function count(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function rows<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

/** Run prepared statements through `env.DB.batch` in chunks (keeps each batch small). */
export async function batchInChunks(statements: D1PreparedStatement[], size = 250): Promise<void> {
  for (let start = 0; start < statements.length; start += size) {
    await env.DB.batch(statements.slice(start, start + size));
  }
}

export interface SeedSession { sessionDate: string; arrows?: number; sessionType?: string; focus?: string; notes?: string; createdAt?: number }

/** Insert training sessions for any mix of users, in array order (ids ascend in that order). */
export async function seedSessionRows(sessions: Array<SeedSession & { userId: string }>): Promise<void> {
  const statement = env.DB.prepare(`INSERT INTO training_sessions
    (user_id, session_date, session_type, custom_activity, arrows, duration_minutes, focus, score, notes, created_at)
    VALUES (?, ?, ?, '', ?, 30, ?, '', ?, ?)`);
  await batchInChunks(sessions.map((session, index) => statement.bind(
    session.userId, session.sessionDate, session.sessionType ?? "Range", session.arrows ?? 30, session.focus ?? "",
    session.notes ?? "", session.createdAt ?? 1_750_000_000_000 + index,
  )));
}

/** Insert training sessions for one user, in array order. */
export function seedSessions(userId: string, sessions: SeedSession[]): Promise<void> {
  return seedSessionRows(sessions.map((session) => ({ ...session, userId })));
}

/**
 * Insert practice scores with their ten ends directly. Ends are attached by
 * (user, score_date, created_at), which the seed keeps unique per score.
 */
export async function seedScores(userId: string, scoreDates: string[]): Promise<void> {
  const base = 1_760_000_000_000;
  const score = env.DB.prepare("INSERT INTO practice_scores (user_id, score_date, total, created_at) VALUES (?, ?, 270, ?)");
  await batchInChunks(scoreDates.map((scoreDate, index) => score.bind(userId, scoreDate, base + index)));
  const ends = env.DB.prepare(`INSERT INTO practice_score_ends (user_id, score_id, end_number, arrow_1, arrow_2, arrow_3, end_total)
    SELECT user_id, id, ?, 8, 9, 10, 27 FROM practice_scores WHERE user_id = ? AND created_at >= ? AND created_at < ?`);
  // One INSERT ... SELECT per (chunk of scores, end number): 10 statements per 250 scores.
  for (let start = 0; start < scoreDates.length; start += 250) {
    await env.DB.batch(Array.from({ length: 10 }, (_unused, end) =>
      ends.bind(end + 1, userId, base + start, base + Math.min(start + 250, scoreDates.length))));
  }
}

/** `YYYY-MM-DD` for `start` plus `days` (UTC noon arithmetic, no DST effects). */
export function dayPlus(start: string, days: number): string {
  const date = new Date(`${start}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function setProgramState(userId: string, state: { poundage: number | null; cycle: number; week: number; anchor: string }): Promise<void> {
  await env.DB.prepare(`INSERT INTO program_state (user_id, current_poundage, current_cycle, current_week, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET current_poundage = excluded.current_poundage, current_cycle = excluded.current_cycle,
      current_week = excluded.current_week, updated_at = excluded.updated_at`)
    .bind(userId, state.poundage, state.cycle, state.week, Date.parse(`${state.anchor}T12:00:00Z`)).run();
}

// ---------------------------------------------------------------------------
// D1 statement counting
// ---------------------------------------------------------------------------

export interface QueryObservation { sql: string; params: unknown[]; rows?: number }
export interface CountedResponse { response: Response; statements: string[]; queries: QueryObservation[] }

/**
 * Runs one request through the Worker's own `fetch` handler with a D1 binding
 * that records every statement the request prepares (Drizzle prepares exactly
 * one statement per query and one per batch item). Same isolate, same storage
 * as `SELF.fetch`; only the `DB` binding is wrapped.
 */
export async function countedRequest(path: string, cookie: string): Promise<CountedResponse> {
  const statements: string[] = [];
  const queries: QueryObservation[] = [];
  function observe(statement: D1PreparedStatement, query: QueryObservation): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...params: unknown[]) => {
          query.params = params;
          return observe(target.bind(...params), query);
        };
        if (property === "raw" || property === "all") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target[property], target, args);
          query.rows = Array.isArray(result) ? result.length : result.results.length;
          return result;
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const counting = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          const query: QueryObservation = { sql, params: [] };
          queries.push(query);
          return observe(target.prepare(sql), query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const request = new Request(new URL(path, BASE_URL).toString(), { headers: { cookie } });
  const response = await worker.fetch(request, { ...env, DB: counting });
  return { response, statements, queries };
}

// ---------------------------------------------------------------------------
// Content-Disposition (work item section 11)
// ---------------------------------------------------------------------------

export interface ParsedDisposition {
  /** The quoted ASCII fallback, without the quotes. */
  fallback: string;
  /** The raw percent-encoded `filename*` value (after `UTF-8''`). */
  encoded: string;
  /** `encoded` decoded as UTF-8. */
  decoded: string;
}

// RFC 5987 attr-char plus "%" for the pct-encoded octets.
const DISPOSITION = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]+)$/;

/**
 * Strict parse of `attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>`.
 * Throws when the header does not have exactly that shape.
 */
export function parseContentDisposition(header: string | null): ParsedDisposition {
  const match = DISPOSITION.exec(header ?? "");
  if (!match) throw new Error(`Content-Disposition does not match section 11: ${JSON.stringify(header)}`);
  const fallback = match[1] as string;
  const encoded = match[2] as string;
  return { fallback, encoded, decoded: decodeURIComponent(encoded) };
}
