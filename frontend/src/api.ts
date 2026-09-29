// Typed fetch client for the Do Good Arching Cloudflare Worker API.
// Same-origin: the SPA is served by the same Worker as `/api/*`, and auth
// rides on the httpOnly `dga_session` cookie, so every request sends
// credentials. Non-2xx responses throw ApiError carrying the server's
// `{ error }` message.

export type DateStr = string; // YYYY-MM-DD
export type SessionType = "Range" | "Gym" | "SPT" | "Class" | "Other";
export type PlanDayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type DayStatus = "completed" | "skipped" | "upcoming";
export type Role = "coach" | "athlete";

export interface SessionInput {
  sessionDate: DateStr;
  sessionType: SessionType;
  customActivity: string;
  arrows: number;
  durationMinutes: number;
  focus: string;
  score: string;
  notes: string;
}
export interface TrainingSession extends SessionInput {
  id: number;
  createdAt: string;
}
export interface PracticeScore {
  id: number;
  scoreDate: DateStr;
  total: number;
  averageArrow: number;
  averageEnd: number;
  ends: { endNumber: number; arrows: [number, number, number]; total: number; averageArrow: number }[];
  createdAt: string;
}
export interface Attachment {
  id: number;
  dayKey: PlanDayKey;
  kind: "document" | "photo" | "link";
  label: string;
  url: string;
  mimeType: string;
  createdAt: string;
}
export interface PlannedSession {
  dayKey: PlanDayKey;
  day: string;
  short: string;
  sessionType: string;
  detail: string;
  prescription: string;
  updatedAt: string | null;
  attachments: Attachment[];
}
export interface CycleWeekPlan {
  weekNumber: number;
  primaryFocus: string;
  backgroundFocusOne: string;
  backgroundFocusTwo: string;
  updatedAt: string;
}
export interface WeeklyNote {
  id: number | null;
  weekStart: DateStr;
  notes: string;
  updatedAt: string | null;
}
export interface HistoricalWeeklyNote {
  id: number;
  weekStart: DateStr;
  notes: string;
  updatedAt: string;
}
export interface CycleSummaryWeek {
  weekNumber: number;
  weekStart: DateStr;
  arrows: number;
  dayStatuses: DayStatus[];
}
export interface CycleSummary {
  cycle: number;
  weeks: CycleSummaryWeek[];
}
export interface BowSetup {
  id: number;
  poundage: number;
  name: string;
  limbRiser: string;
  tillerBolts: string;
  braceHeight: string;
  stringTwists: string;
  nockingPoint: string;
  centerShot: string;
  plunger: string;
  gripNotes: string;
  stabilizer: string;
  clickerPosition: string;
  bareShaft: string;
  walkBack: string;
  arrowsInUse: string;
  sightMarks: Record<string, string>;
  updatedAt: string;
}
export interface Inspiration {
  thoughtText: string;
  videoTitle: string;
  videoUrl: string;
  recipeName: string;
  recipeSummary: string;
  recipeIngredients: string;
  recipeInstructions: string;
  updatedAt: string;
}
export interface Recipe {
  id: number;
  name: string;
  summary: string;
  ingredients: string;
  instructions: string;
  updatedAt: string;
}
export interface MaintenanceItem {
  id: number;
  section: "Weekly" | "Monthly" | "Quarterly";
  label: string;
  checked: boolean;
}

export interface TrackerPayload {
  /** `currentPoundage` is null until the athlete sets it (see `api.savePoundage`). */
  state: { currentPoundage: number | null; currentCycle: number; currentWeek: number };
  weeklyPlans: CycleWeekPlan[];
  plannedSessions: PlannedSession[];
  sessions: TrainingSession[];
  practiceScores: PracticeScore[];
  currentWeeklyNote: WeeklyNote;
  historicalWeeklyNotes: HistoricalWeeklyNote[];
  weeklyArrows: { week: string; arrows: number }[];
  cycleSummaries: CycleSummary[];
  milestoneChecks: Record<string, boolean>;
  maintenanceChecks: Record<string, boolean>;
  maintenanceItems: MaintenanceItem[];
  setups: BowSetup[];
  inspiration: Inspiration | null;
  recipes: Recipe[];
}

/** The public user shape returned by bootstrap, login, accept-invite and `/api/auth/me`. */
export interface Me {
  id: string;
  username: string;
  role: Role;
  /** Current team owner. Ownership can be transferred to another coach. */
  isOwner: boolean;
}

/** Invite as listed by `GET /api/auth/invites`; instants are epoch milliseconds. */
export interface Invite {
  id: string;
  role: Role;
  createdBy: string | null;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface AthleteSummary {
  id: string;
  username: string;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface CoachSummary {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
}

export interface CoachAthleteOverview {
  state: TrackerPayload["state"];
  weeklyPlans: CycleWeekPlan[];
  plannedSessions: PlannedSession[];
  weeklyArrows: { week: string; arrows: number }[];
  cycleSummaries: CycleSummary[];
}

export interface ExportPayload {
  version: number;
  exportedAt: string;
  username: string;
  data: Record<string, unknown>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      ...init,
    });
  } catch {
    throw new ApiError(0, "Couldn’t reach the server. Check your connection and try again.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the fallback message
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const jsonBody = (body: unknown): RequestInit => body === undefined ? {} : {
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
};
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: "POST", ...jsonBody(body) });
const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PUT", ...jsonBody(body) });
const del = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: "DELETE", ...jsonBody(body) });

export interface PlannedSessionFileInput {
  dayKey: PlanDayKey;
  kind: "document" | "photo";
  label: string;
  file: Blob;
}

function uploadFile(path: string, { dayKey, kind, label, file }: PlannedSessionFileInput) {
  const query = new URLSearchParams({ dayKey, kind, label });
  return request<{ id: number }>(`${path}?${query}`, {
    method: "POST", headers: { "Content-Type": file.type, "X-File-Size": String(file.size) }, body: file,
  });
}

export const api = {
  // ---- auth ----
  authStatus: () => get<{ setupRequired: boolean }>("/api/auth/status"),
  bootstrap: (args: { username: string; password: string }) => post<Me>("/api/auth/bootstrap", args),
  login: (args: { username: string; password: string }) => post<Me>("/api/auth/login", args),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  changePassword: (args: { currentPassword: string; newPassword: string }) => post<{ ok: true }>("/api/auth/password", args),
  logoutAll: () => post<{ ok: true }>("/api/auth/logout-all"),
  deleteAccount: (args: { password: string }) => del<{ ok: true }>("/api/auth/account", args),
  transferOwnership: (args: { coachId: string; password: string }) =>
    post<{ ok: true; previousOwnerId: string; newOwnerId: string }>("/api/auth/owner/transfer", args),
  me: () => get<Me>("/api/auth/me"),
  // Any coach may create athlete invites; only the owner may create coach invites (403 otherwise).
  createInvite: (args: { role: Role } = { role: "athlete" }) =>
    post<{ token: string; invitePath: string; expiresInHours: number }>("/api/auth/invites", args),
  // The owner sees every invite; other coaches see (and can revoke) only their own.
  listInvites: () => get<Invite[]>("/api/auth/invites"),
  revokeInvite: (args: { id: string }) => del<{ ok: true }>(`/api/auth/invites/${encodeURIComponent(args.id)}`),
  acceptInvite: (args: { token: string; username: string; password: string }) =>
    post<Me>("/api/auth/accept-invite", args),

  // ---- personal tracker (own data) ----
  // `before` is the exclusive "${sessionDate},${id}" cursor of the last session
  // already shown; it pages only `sessions` (100 per page, newest first).
  getTracker: (args: { today: string; before?: string }) => {
    const query = new URLSearchParams({ today: args.today });
    if (args.before) query.set("before", args.before);
    return get<TrackerPayload>(`/api/tracker?${query.toString()}`);
  },
  /** Cursor for loading sessions older than `session` (see `getTracker`). */
  sessionCursor: (session: Pick<TrainingSession, "sessionDate" | "id">) => `${session.sessionDate},${session.id}`,
  savePoundage: (args: { poundage: number; today: DateStr }) => post<{ currentPoundage: number }>("/api/plan/poundage", args),
  saveWeeklyNote: (args: { today: string; notes: string }) => post<WeeklyNote>("/api/notes/weekly", args),
  addSession: (args: SessionInput) => post<{ id: number }>("/api/sessions", args),
  updateSession: (args: { id: number } & SessionInput) =>
    put<{ ok: true }>(`/api/sessions/${args.id}`, args),
  deleteSession: (args: { id: number }) => del<{ ok: true }>(`/api/sessions/${args.id}`),
  addPracticeScore: (args: { scoreDate: DateStr; ends: [number, number, number][] }) =>
    post<{ id: number; total: number; averageArrow: number }>("/api/scores", args),
  deletePracticeScore: (args: { id: number }) => del<{ ok: true }>(`/api/scores/${args.id}`),
  savePlannedSession: (args: { dayKey: PlanDayKey; sessionType: string; detail: string; prescription: string }) =>
    post<PlannedSessionWrite>("/api/plan/sessions", args),
  addPlannedSessionLink: (args: { dayKey: PlanDayKey; label: string; url: string }) =>
    post<{ id: number }>("/api/plan/sessions/links", args),
  addPlannedSessionFile: (args: PlannedSessionFileInput) => uploadFile("/api/plan/sessions/files", args),
  deletePlannedSessionAttachment: (args: { id: number }) =>
    del<{ ok: true }>(`/api/plan/attachments/${args.id}`),
  plannedSessionAttachmentFileUrl: (id: number) => `/api/plan/attachments/${id}/file`,
  saveCycleWeekPlan: (args: {
    weekNumber: number;
    primaryFocus: string;
    backgroundFocusOne: string;
    backgroundFocusTwo: string;
  }) => post<CycleWeekPlan>("/api/plan/weeks", args),
  adjustSchedule: (args: { adjustment: "skip" | "forward" | "back"; today: string }) =>
    post<{ currentCycle: number; currentWeek: number; adjustment: string }>("/api/plan/adjust", args),
  setCheck: (args: { group: "milestone" | "maintenance"; key: string; checked: boolean }) =>
    post<{ ok: true }>("/api/checks", args),
  addMaintenanceItem: (args: { section: MaintenanceItem["section"]; label: string }) =>
    post<{ id: number }>("/api/maintenance/items", args),
  updateMaintenanceItem: (args: { id: number; label: string }) =>
    put<{ ok: true }>(`/api/maintenance/items/${args.id}`, { label: args.label }),
  deleteMaintenanceItem: (args: { id: number }) => del<{ ok: true }>(`/api/maintenance/items/${args.id}`),
  setMaintenanceItemChecked: (args: { id: number; checked: boolean }) =>
    post<{ ok: true }>(`/api/maintenance/items/${args.id}/check`, { checked: args.checked }),
  clearMaintenanceSection: (args: { section: MaintenanceItem["section"] }) =>
    post<{ ok: true }>("/api/maintenance/sections/clear", args),
  saveSetup: (args: Omit<BowSetup, "id" | "updatedAt"> & { id?: number }) =>
    post<{ id: number }>("/api/setups", args),
  duplicateSetup: (args: { id: number; poundage: number }) =>
    post<{ id: number }>(`/api/setups/${args.id}/duplicate`, { poundage: args.poundage }),
  saveInspiration: (args: {
    thoughtText: string;
    videoTitle: string;
    videoUrl: string;
    recipeName: string;
    recipeSummary: string;
    recipeIngredients: string;
    recipeInstructions: string;
  }) => post<Inspiration>("/api/inspiration", args),

  // ---- coach (athlete's plans/summaries only; never private log rows) ----
  listAthletes: (args: { includeDeactivated?: boolean } = {}) =>
    get<{ athletes: AthleteSummary[] }>(`/api/coach/athletes${args.includeDeactivated ? "?include=deactivated" : ""}`),
  deactivateAthlete: (athleteId: string) => post<AthleteSummary>(`/api/coach/athletes/${encodeURIComponent(athleteId)}/deactivate`),
  reactivateAthlete: (athleteId: string) => post<AthleteSummary>(`/api/coach/athletes/${encodeURIComponent(athleteId)}/reactivate`),
  listCoaches: () => get<{ coaches: CoachSummary[] }>("/api/coach/coaches"), // owner only (403 otherwise)
  athleteOverview: (athleteId: string, today: string) =>
    get<CoachAthleteOverview>(
      `/api/coach/athletes/${encodeURIComponent(athleteId)}/overview?today=${encodeURIComponent(today)}`,
    ),
  coachSavePlannedSession: (
    athleteId: string,
    args: { dayKey: PlanDayKey; sessionType: string; detail: string; prescription: string },
  ) => put<PlannedSessionWrite>(`/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/sessions`, args),
  coachAddPlannedSessionLink: (athleteId: string, args: { dayKey: PlanDayKey; label: string; url: string }) =>
    post<{ id: number }>(`/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/sessions/links`, args),
  coachAddPlannedSessionFile: (
    athleteId: string,
    args: PlannedSessionFileInput,
  ) => uploadFile(`/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/sessions/files`, args),
  coachDeletePlannedSessionAttachment: (athleteId: string, attachmentId: number) =>
    del<{ ok: true }>(
      `/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/attachments/${attachmentId}`,
    ),
  coachSaveCycleWeekPlan: (
    athleteId: string,
    args: {
      weekNumber: number;
      primaryFocus: string;
      backgroundFocusOne: string;
      backgroundFocusTwo: string;
    },
  ) => put<CycleWeekPlan>(`/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/weeks`, args),
  coachAdjustSchedule: (athleteId: string, args: { adjustment: "skip" | "forward" | "back"; today: string }) =>
    post<{ currentCycle: number; currentWeek: number; adjustment: string }>(
      `/api/coach/athletes/${encodeURIComponent(athleteId)}/plan/adjust`,
      args,
    ),

  // ---- export / import (own account only) ----
  exportData: () => get<ExportPayload>("/api/export"),
  importData: (payload: ExportPayload) =>
    post<{ ok: true; counts: Record<string, number> }>("/api/import", payload),
};

/** Plan mutations return only persisted fields; read-only labels/attachments are in tracker reads. */
export type PlannedSessionWrite = Pick<PlannedSession, "dayKey" | "sessionType" | "detail" | "prescription"> & { updatedAt: string };
