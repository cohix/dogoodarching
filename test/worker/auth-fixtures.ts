/**
 * Extra fixtures for the auth / invite / RBAC / team tests. Extends
 * `helpers.ts` without modifying it.
 */
import { uploadFile } from "./helpers";
import { env } from "cloudflare:test";
import { sha256Hex } from "../../src/lib/auth";
import { acceptInvite, api, apiJson, bootstrapCoach, createInvite, DEFAULT_PASSWORD, type Session } from "./helpers";

export const credentials = (username: string) => ({ username, password: DEFAULT_PASSWORD });

/** Owner + a second (non-owner) coach + two athletes, one invited by each coach. */
export interface Team {
  owner: Session;
  coach: Session;
  athleteA: Session;
  athleteB: Session;
}

export async function setupTeam(): Promise<Team> {
  const owner = await bootstrapCoach("owner");
  const coach = await acceptInvite(await createInvite(owner, { role: "coach" }), "coach2");
  const athleteA = await acceptInvite(await createInvite(owner), "athleteA");
  const athleteB = await acceptInvite(await createInvite(coach), "athleteB");
  return { owner, coach, athleteA, athleteB };
}

/** Number of rows in `table`, optionally filtered by a raw `where` clause. */
export async function countRows(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  created_by: string | null;
  role: "athlete" | "coach";
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

/** The stored invite row for a raw token (tokens are stored hashed). */
export async function inviteRowFor(token: string): Promise<InviteRow | null> {
  return env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(await sha256Hex(token)).first<InviteRow>();
}

/** Move an invite's expiry to `expiresAt` (epoch ms) directly in D1. */
export async function setInviteExpiry(token: string, expiresAt: number): Promise<void> {
  const result = await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE token_hash = ?").bind(expiresAt, await sha256Hex(token)).run();
  if (result.meta.changes !== 1) throw new Error("invite not found");
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "coach" | "athlete";
  is_owner: number;
  invited_by: string | null;
  created_at: number;
}

export async function userRow(id: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/** Delete a user row directly (cascades sessions; `SET NULL` on invites/invited_by). */
export async function deleteUser(id: string): Promise<void> {
  if (!(await userRow(id))) throw new Error(`user ${id} not found`);
  // D1 reports cascaded rows in meta.changes, so verify by re-reading.
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  if (await userRow(id)) throw new Error(`user ${id} still exists`);
}

/** Strip the owner flag from a user directly (0002 has no ownership transfer endpoint yet). */
export async function demoteOwner(id: string): Promise<void> {
  const result = await env.DB.prepare("UPDATE users SET is_owner = 0 WHERE id = ? AND is_owner = 1").bind(id).run();
  if (result.meta.changes !== 1) throw new Error(`user ${id} is not the owner`);
}

/** A tiny valid-looking file body for upload tests. */
export const SAMPLE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"
export const SAMPLE_BASE64 = btoa(String.fromCharCode(...SAMPLE_BYTES));

export function filePayload(overrides: Record<string, unknown> = {}) {
  return { dayKey: "mon", kind: "document", label: "Plan notes", mimeType: "application/pdf", dataBase64: SAMPLE_BASE64, ...overrides };
}

/** Athlete uploads a plan file for themselves; returns the attachment id. */
export async function uploadOwnFile(session: Session, overrides: Record<string, unknown> = {}): Promise<number> {
  const response = await uploadFile("/api/plan/sessions/files", session, filePayload(overrides));
  const status = response.status;
  const body = await response.json() as { id: number };
  if (status !== 200) throw new Error(`upload failed: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

/** Coach uploads a plan file for an athlete; returns the attachment id. */
export async function uploadFileForAthlete(coach: Session, athleteId: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const response = await uploadFile(`/api/coach/athletes/${athleteId}/plan/sessions/files`, coach, filePayload(overrides));
  const status = response.status;
  const body = await response.json() as { id: number };
  if (status !== 200) throw new Error(`coach upload failed: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

/** Athlete adds a link attachment for themselves; returns the attachment id. */
export async function addOwnLink(session: Session): Promise<number> {
  const { status, body } = await apiJson<{ id: number }>("/api/plan/sessions/links", {
    json: { dayKey: "tue", label: "Video", url: "https://example.org/video" }, cookie: session.cookie,
  });
  if (status !== 200) throw new Error(`link failed: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

/** Records one invalid auth attempt, useful when testing allowance accounting. */
export async function warmRateLimit(path: "/api/auth/bootstrap" | "/api/auth/accept-invite" | "/api/auth/login"): Promise<void> {
  const response = await api(path, { json: {} }); // fails validation after the limiter ran
  if (response.status !== 400) throw new Error(`warm-up expected 400, got ${response.status}`);
}

/** Raw accept-invite call returning the response (no throw on non-201). */
export function tryAccept(token: string, username: string, password = DEFAULT_PASSWORD): Promise<Response> {
  return api("/api/auth/accept-invite", { json: { token, username, password } });
}

export type Overview = {
  state: { currentPoundage: number | null; currentCycle: number; currentWeek: number };
  weeklyPlans: Array<{ weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string; updatedAt: string }>;
  plannedSessions: Array<{
    dayKey: string; sessionType: string; detail: string; prescription: string; updatedAt: string | null;
    attachments: Array<{ id: number; kind: string; label: string; url: string }>;
  }>;
  weeklyArrows: unknown[];
  cycleSummaries: unknown[];
};

export async function overview(coach: Session, athleteId: string): Promise<Overview> {
  const { status, body } = await apiJson<Overview>(`/api/coach/athletes/${athleteId}/overview`, { cookie: coach.cookie });
  if (status !== 200) throw new Error(`overview failed: ${status} ${JSON.stringify(body)}`);
  return body;
}
