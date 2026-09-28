import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  api,
  fileToBase64,
  ApiError,
  type AthleteSummary,
  type BowSetup,
  type CycleSummary,
  type DayStatus,
  type HistoricalWeeklyNote,
  type Me,
  type PlanDayKey,
  type PlannedSession,
  type PracticeScore,
  type Recipe,
  type SessionType,
  type TrackerPayload,
  type TrainingSession,
} from "./api";
import sptWorkoutPageOne from "./assets/wednesday-spt-band-workout-page-1.png";
import sptWorkoutPageTwo from "./assets/wednesday-spt-band-workout-page-2.png";

type Tracker = TrackerPayload;
type Setup = Tracker["setups"][number];
type WeeklyNote = HistoricalWeeklyNote;
type PlannedSessionDraft = Pick<PlannedSession, "dayKey" | "sessionType" | "detail" | "prescription">;
type SetupDraft = Omit<Setup, "id" | "updatedAt"> & { id?: number };
type SetupTextKey = Exclude<keyof SetupDraft, "id" | "poundage" | "name" | "sightMarks">;
type Tab = "dashboard" | "log" | "plan" | "bow" | "nutrition" | "team" | "settings";
type MaintenanceSection = Tracker["maintenanceItems"][number]["section"];

const routine = [
  { dayKey: "mon", day: "Monday", short: "Mon", sessionType: "Gym", detail: "Strength & core", prescription: "Back-tension rows/pull-downs · planks & rotational chops · rotator cuff", updatedAt: null, attachments: [] },
  { dayKey: "tue", day: "Tuesday", short: "Tue", sessionType: "Range", detail: "100–150 arrows", prescription: "Begin with 30 blank-bale arrows, then apply the week’s focus", updatedAt: null, attachments: [] },
  { dayKey: "wed", day: "Wednesday", short: "Wed", sessionType: "SPT", detail: "Band workout at home", prescription: "Draws 3×8–10 (5s hold) · T-raises 3×12 · Y-press 3×10 · cuff rotations 3×15 · thoracic expansion 2×8 · dynamic release 3×6 · torso rotations 3×12/side · Holding Song 3m28s", updatedAt: null, attachments: [] },
  { dayKey: "thu", day: "Thursday", short: "Thu", sessionType: "Class", detail: "Class / Coaching", prescription: "Form review and video analysis", updatedAt: null, attachments: [] },
  { dayKey: "fri", day: "Friday", short: "Fri", sessionType: "Gym", detail: "Strength & core", prescription: "Back-tension rows/pull-downs · planks & rotational chops · rotator cuff", updatedAt: null, attachments: [] },
  { dayKey: "sat", day: "Saturday", short: "Sat", sessionType: "Range", detail: "100–150 arrows", prescription: "Begin with 30 blank-bale arrows, then apply the week’s focus", updatedAt: null, attachments: [] },
  { dayKey: "sun", day: "Sunday", short: "Sun", sessionType: "Rest", detail: "Rest", prescription: "Recovery day", updatedAt: null, attachments: [] },
] satisfies PlannedSession[];
function plannedSessionsFor(data: { plannedSessions: PlannedSession[] }): PlannedSession[] { return data.plannedSessions.length ? data.plannedSessions : routine; }
type CyclePlanItem = { weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string };
const defaultCycle: CyclePlanItem[] = [
  { weekNumber: 1, primaryFocus: "Back Activation", backgroundFocusOne: "Posture / stance", backgroundFocusTwo: "String-hand hook / draw" },
  { weekNumber: 2, primaryFocus: "Relaxed Bow Hand", backgroundFocusOne: "Core engagement / stance", backgroundFocusTwo: "Facial reference / anchor" },
  { weekNumber: 3, primaryFocus: "Head Position", backgroundFocusOne: "Nocking / pre-shot", backgroundFocusTwo: "Endurance hold / follow-through" },
  { weekNumber: 4, primaryFocus: "Thoracic Rotation", backgroundFocusOne: "Setup / stance", backgroundFocusTwo: "Timing / execution" },
  { weekNumber: 5, primaryFocus: "Hip Stability", backgroundFocusOne: "One-eye aiming", backgroundFocusTwo: "Follow-through / execution" },
  { weekNumber: 6, primaryFocus: "Release", backgroundFocusOne: "Self-talk / mental", backgroundFocusTwo: "Practice score / simulation" },
];
function cyclePlanFor(data: { weeklyPlans: { weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string }[] }): CyclePlanItem[] {
  return defaultCycle.map((fallback) => {
    const saved = data.weeklyPlans.find((plan) => plan.weekNumber === fallback.weekNumber);
    return saved ? { weekNumber: saved.weekNumber, primaryFocus: saved.primaryFocus, backgroundFocusOne: saved.backgroundFocusOne, backgroundFocusTwo: saved.backgroundFocusTwo } : fallback;
  });
}
const milestones = [
  { weight: 24, target: "Consolidate now", note: "Full stabilizer · clicker after static draw-length check", tasks: ["Integrate full stabilizer setup", "Add clicker once draw length is verified static", "Bare-shaft tune at 24 lb", "Complete walk-back tune", "Record sight marks through 70 m"] },
  { weight: 28, target: "Target Nov 2026", note: "Automate stabilizer + clicker for outdoor season", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
  { weight: 32, target: "Target Feb 2027", note: "Transition to micro-diameter arrows", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
  { weight: 34, target: "Target May 2027", note: "Competition setup", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
];
const maintenanceSections: MaintenanceSection[] = ["Weekly", "Monthly", "Quarterly"];
const athleteNav: { id: Tab; label: string; mark: string }[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "log", label: "Log", mark: "02" }, { id: "plan", label: "Plan", mark: "03" },
  { id: "bow", label: "Gear", mark: "04" }, { id: "nutrition", label: "Fuel", mark: "05" }, { id: "settings", label: "Settings", mark: "06" },
];
const coachNav: { id: Tab; label: string; mark: string }[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "log", label: "Log", mark: "02" }, { id: "plan", label: "Plan", mark: "03" },
  { id: "bow", label: "Gear", mark: "04" }, { id: "nutrition", label: "Fuel", mark: "05" }, { id: "team", label: "Team", mark: "06" },
  { id: "settings", label: "Settings", mark: "07" },
];
const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };
const mondayOf = (date: Date) => { const start = new Date(date); const day = start.getDay(); start.setHours(12, 0, 0, 0); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); return start; };
type TrainingDayStatus = "completed" | "skipped" | "upcoming";
const statusColor: Record<TrainingDayStatus, string> = { completed: "var(--status-completed)", skipped: "var(--status-skipped)", upcoming: "var(--status-upcoming)" };
function prescribedType(date: string): SessionType { const day = new Date(`${date}T12:00:00`).getDay(); return (["Gym", "Gym", "Range", "SPT", "Class", "Gym", "Range"] as SessionType[])[day] ?? "Range"; }
type VideoSource = { embedUrl: string; sourceUrl: string; provider: "YouTube" | "Vimeo" };

/** Defense-in-depth: only http/https values are ever rendered as links. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function SafeLink({ url, className, children }: { url: string; className?: string; children: React.ReactNode }) {
  const href = safeHttpUrl(url);
  if (!href) return null;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

function youtubeVideoSource(id: string, sourceUrl: string): VideoSource {
  const encodedId = encodeURIComponent(id);
  return {
    embedUrl: `https://www.youtube.com/embed/${encodedId}?playsinline=1&rel=0&controls=1`,
    sourceUrl,
    provider: "YouTube",
  };
}

function normalizeVideoSource(value: string): VideoSource | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (host === "youtu.be") {
      const id = pathParts[0];
      return id ? youtubeVideoSource(id, value) : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (pathParts[0] === "embed" && pathParts[1]) {
        return youtubeVideoSource(pathParts[1], `https://www.youtube.com/watch?v=${encodeURIComponent(pathParts[1])}`);
      }
      const id = url.pathname === "/watch"
        ? url.searchParams.get("v")
        : pathParts[0] === "shorts" ? pathParts[1] : null;
      return id ? youtubeVideoSource(id, value) : null;
    }

    if (host === "player.vimeo.com" && pathParts[0] === "video" && /^\d+$/.test(pathParts[1] ?? "")) {
      return { embedUrl: value, sourceUrl: `https://vimeo.com/${pathParts[1]}`, provider: "Vimeo" };
    }
    if (host === "vimeo.com") {
      const id = pathParts.find((part) => /^\d+$/.test(part));
      return id ? { embedUrl: `https://player.vimeo.com/video/${id}`, sourceUrl: value, provider: "Vimeo" } : null;
    }

    return null;
  } catch {
    return null;
  }
}

function InlineVideo({ video, title }: { video: VideoSource; title: string }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [video.embedUrl]);
  const separator = video.embedUrl.includes("?") ? "&" : "?";
  const playerUrl = `${video.embedUrl}${separator}autoplay=1`;

  return <div className="relative aspect-video w-full overflow-hidden bg-[#111512] text-white">
    {playing ? <iframe
      className="absolute inset-0 h-full w-full border-0"
      src={playerUrl}
      title={`${title} — inline video player`}
      loading="eager"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      referrerPolicy="origin-when-cross-origin"
    /> : <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${title} inline`}
      className="absolute inset-0 flex h-full w-full flex-col items-center justify-center gap-3 bg-[#111512] px-6 text-center"
    >
      <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-2xl text-[#111512]">▶</span>
      <span className="text-sm font-bold">Play video here</span>
    </button>}
  </div>;
}

function Empty({ children }: { children: string }) { return <div className="card px-5 py-8 text-center text-sm text-[var(--dim)]">{children}</div>; }
function CheckRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start gap-3 py-2.5"><input className="check mt-0.5 shrink-0" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span className={checked ? "text-sm text-[var(--dim)] line-through" : "text-sm text-[var(--text)]"}>{label}</span></label>;
}

function ShareIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>;
}

function ShareButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label={label} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text)]"><ShareIcon /></button>;
}

function PencilIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>;
}

function TrashIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>;
}

function sessionLabel(session: Pick<TrainingSession, "sessionType" | "customActivity">) {
  return session.sessionType === "Other" && session.customActivity.trim() ? session.customActivity : session.sessionType;
}

function sessionShareText(session: TrainingSession) {
  return [
    `Do Good Arching — ${sessionLabel(session)} session`,
    `Date: ${formatDate(session.sessionDate)}`,
    session.durationMinutes ? `Duration: ${session.durationMinutes} min` : "",
    session.arrows ? `Arrows: ${session.arrows}` : "",
    session.focus ? `Focus: ${session.focus}` : "",
    session.score ? `Score: ${session.score}` : "",
    session.notes ? `Notes: ${session.notes}` : "",
  ].filter(Boolean).join("\n");
}

function practiceScoreShareText(score: PracticeScore) {
  const ends = score.ends.map((end) => `End ${end.endNumber}: ${end.arrows.join(", ")} — ${end.total} (avg ${formatAverage(end.averageArrow)})`).join("\n");
  return [
    "Do Good Arching — Practice score",
    `Date: ${formatDate(score.scoreDate)}`,
    `Total: ${score.total}/300`,
    `Average arrow: ${formatAverage(score.averageArrow)}`,
    `Average end: ${formatAverage(score.averageEnd)}`,
    "",
    ends,
  ].join("\n");
}

function weeklyNoteShareText(note: WeeklyNote) {
  return ["Do Good Arching — Weekly notes", `Week of ${formatDate(note.weekStart)}`, "", note.notes].join("\n");
}

function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
}

// ---------------------------------------------------------------------------
// Auth gate, invite accept, and the authed tracker shell
// ---------------------------------------------------------------------------

const inviteTokenFromPath = (): string | null => {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export function App() {
  const [inviteToken, setInviteToken] = useState<string | null>(() => inviteTokenFromPath());
  if (inviteToken) {
    return <InviteAcceptScreen
      token={inviteToken}
      onDone={() => {
        window.history.replaceState(null, "", "/");
        setInviteToken(null);
      }}
    />;
  }
  return <AuthGate />;
}

function AuthGate() {
  const qc = useQueryClient();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  if (meQuery.isPending) return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe text-sm text-[var(--dim)]">Loading…</div>;
  if (meQuery.error) {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      return <AuthScreen onAuthed={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
    }
    return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe">
      <p className="text-sm text-[var(--text)]">Couldn’t reach your training data.</p>
      <button type="button" className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white" onClick={() => meQuery.refetch()}>Try again</button>
    </div>;
  }
  if (!meQuery.data) return <AuthScreen onAuthed={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
  return <TrackerShell me={meQuery.data} />;
}

function AuthFormCard({ title, subtitle, submitLabel, pending, error, onSubmit, username, setUsername, password, setPassword }: {
  title: string; subtitle: string; submitLabel: string; pending: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  username: string; setUsername: (value: string) => void; password: string; setPassword: (value: string) => void;
}) {
  return <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 pb-safe pt-safe text-[var(--text)]">
    <div className="w-full max-w-sm">
      <p className="text-center text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p>
      <h1 className="mt-2 text-center text-3xl font-extrabold tracking-[-.03em]">{title}</h1>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--dim)]">{subtitle}</p>
      <form onSubmit={onSubmit} className="card mt-6 space-y-4 p-5">
        <label><span className="label">Username</span><input className="field" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} placeholder="3–32 chars: letters, numbers, _ or -" required /></label>
        <label><span className="label">Password</span><input className="field" type="password" maxLength={128} autoComplete={title === "Create coach account" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" required /></label>
        {error && <p role="alert" className="text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
        <button type="submit" disabled={pending} className="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{pending ? "Please wait…" : submitLabel}</button>
      </form>
    </div>
  </div>;
}

function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"checking" | "bootstrap" | "login">("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    api.authStatus()
      .then((status) => { if (live) setMode(status.setupRequired ? "bootstrap" : "login"); })
      .catch(() => { if (live) setError("Couldn’t reach the server. Check your connection and try again."); });
    return () => { live = false; };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { setError("Username must be 3–32 characters: letters, numbers, _ or -."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setPending(true);
    try {
      if (mode === "bootstrap") await api.bootstrap({ username, password });
      else await api.login({ username, password });
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  };
  if (mode === "checking") {
    if (error) {
      return <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 pb-safe pt-safe text-[var(--text)]">
        <div className="w-full max-w-sm text-center">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p>
          <p role="alert" className="mt-3 text-sm leading-6">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Try again</button>
        </div>
      </div>;
    }
    return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe text-sm text-[var(--dim)]">Loading…</div>;
  }
  if (mode === "bootstrap") {
    return <AuthFormCard
      title="Create coach account" subtitle="No accounts exist yet. The first account becomes the coach — athletes join later through your invites."
      submitLabel="Create account" pending={pending} error={error} onSubmit={submit}
      username={username} setUsername={setUsername} password={password} setPassword={setPassword}
    />;
  }
  return <AuthFormCard
    title="Welcome back" subtitle="Log in to your training tracker."
    submitLabel="Log in" pending={pending} error={error} onSubmit={submit}
    username={username} setUsername={setUsername} password={password} setPassword={setPassword}
  />;
}

function InviteAcceptScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { setError("Username must be 3–32 characters: letters, numbers, _ or -."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setPending(true);
    try {
      await api.acceptInvite({ token, username, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError("This invite has expired or was already used. Ask your coach for a new one.");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      }
    } finally {
      setPending(false);
    }
  };
  return <AuthFormCard
    title="Join your team" subtitle="Your coach invited you to Do Good Arching. Pick a username and password to create your athlete account."
    submitLabel="Join and log in" pending={pending} error={error} onSubmit={submit}
    username={username} setUsername={setUsername} password={password} setPassword={setPassword}
  />;
}

function TrackerShell({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [openLogOnArrival, setOpenLogOnArrival] = useState(false);
  const [cycleHistoryOpen, setCycleHistoryOpen] = useState(false);
  const qc = useQueryClient();
  const today = localDate();
  const tracker = useQuery({ queryKey: ["tracker", today], queryFn: () => api.getTracker({ today }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tracker"] });
  const check = useMutation({ mutationFn: (args: { group: "milestone" | "maintenance"; key: string; checked: boolean }) => api.setCheck(args), onSuccess: refresh });
  const nav = me.role === "coach" ? coachNav : athleteNav;
  if (tracker.isPending) return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe text-sm text-[var(--dim)]">Loading training data…</div>;
  if (!tracker.data || tracker.error) return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe"><p className="text-sm text-[var(--text)]">Training data couldn’t be loaded.</p><button type="button" className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white" onClick={() => tracker.refetch()}>Try again</button></div>;
  const data = tracker.data;
  const title = nav.find((item) => item.id === tab)?.label ?? "Today";
  return <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
    <div aria-hidden="true" className="bg-[var(--bg)] pt-safe" />
    <header className="mx-auto flex max-w-3xl items-end justify-between px-4 pb-4 pt-8">
      <div><p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p><h1 className="mt-1 text-3xl font-extrabold tracking-[-.03em]">{title}</h1></div>
      {tab === "dashboard" ? <button type="button" onClick={() => setCycleHistoryOpen(true)} className="min-h-9 rounded-lg px-2.5 py-1.5 text-xs font-bold text-[var(--accent)]">History</button> : <div className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs font-bold">{data.state.currentPoundage} lb</div>}
    </header>
    <main className="mx-auto max-w-3xl px-4 pb-28">
      {tab === "dashboard" && <Dashboard data={data} onSaved={refresh} onLog={() => { setOpenLogOnArrival(true); setTab("log"); }} />}
      {tab === "log" && <TrainingLog data={data} onSaved={refresh} openOnArrival={openLogOnArrival} />}
      {tab === "plan" && <TrainingPlan data={data} onSaved={refresh} onCheck={(key, checked) => check.mutate({ group: "milestone", key, checked })} />}
      {tab === "bow" && <BowAndGear data={data} onSaved={refresh} />}
      {tab === "nutrition" && <Nutrition recipes={data.recipes} />}
      {tab === "team" && <TeamTab />}
      {tab === "settings" && <SettingsTab me={me} />}
    </main>
    {cycleHistoryOpen && <CycleHistoryModal summaries={data.cycleSummaries.filter((summary) => summary.cycle < data.state.currentCycle)} onClose={() => setCycleHistoryOpen(false)} />}
    <nav aria-label="Primary" className={`fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] pb-safe backdrop-blur-md`}>
      <div className={`mx-auto grid max-w-3xl px-1 py-2 ${nav.length > 6 ? "grid-cols-7" : "grid-cols-6"}`}>{nav.map((item) => <button key={item.id} aria-label={item.label} aria-current={tab === item.id ? "page" : undefined} onClick={() => { setOpenLogOnArrival(false); setTab(item.id); }} className={`min-w-0 rounded-lg px-1 py-1.5 text-center ${tab === item.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--dim)]"}`}><span className="block text-[10px] font-black tracking-widest">{item.mark}</span><span className="block truncate text-[11px] font-semibold">{item.label}</span></button>)}</div>
    </nav>
  </div>;
}

function WeeklySessionRing({ days, onLog, completedToday }: { days: { date: string; label: string; status: TrainingDayStatus }[]; onLog: () => void; completedToday: boolean }) {
  const statusSummary = days.map((day) => `${day.label} ${day.status}`).join(", ");
  const actionLabel = completedToday ? "Today’s training is logged. Log another session" : "Log today’s training";
  return <div className="w-28 shrink-0 text-center">
    <button type="button" onClick={onLog} aria-label={`${actionLabel}. This week: ${statusSummary}`} className="relative mx-auto flex h-[88px] w-[88px] items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#17372a]">
      <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90 overflow-visible">
        {days.map((day, index) => <circle key={day.date} cx="50" cy="50" r="43" pathLength="100" fill="none" stroke={statusColor[day.status]} strokeWidth="8" strokeLinecap="round" strokeDasharray="14.1 85.9" transform={`rotate(${index * 60} 50 50)`} />)}
      </svg>
      <span aria-hidden="true" className={`relative flex h-12 w-12 items-center justify-center rounded-full bg-white/10 leading-none text-white ${completedToday ? "text-[28px] font-bold" : "text-[34px] font-light"}`}>{completedToday ? "✓" : "+"}</span>
    </button>
    <p className="mt-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#c7dbcf]">{completedToday ? "Nice work!" : "Log today"}</p>
    <div aria-hidden="true" className="mt-1 grid grid-cols-6 gap-0.5">{days.map((day) => <span key={day.date} className="text-[9px] font-black" style={{ color: statusColor[day.status] }}>{day.label.slice(0, 1)}</span>)}</div>
  </div>;
}

function CycleSummaryCard({ summary }: { summary: CycleSummary }) {
  const total = summary.weeks.reduce((sum, week) => sum + week.arrows, 0);
  const average = total / 6;
  return <section className="card p-4" aria-label={`Cycle ${summary.cycle}: ${total} arrows total, ${formatAverage(average)} average arrows per week`}>
    <h3 className="text-sm font-extrabold">Cycle {summary.cycle}</h3>
    <div className="mt-3 grid grid-cols-6 gap-2" role="img" aria-label={summary.weeks.map((week) => `Week ${week.weekNumber}: ${week.arrows} arrows`).join(", ")}>
      {summary.weeks.map((week) => <div key={week.weekNumber} className="min-w-0"><div className="flex gap-[2px]">{week.dayStatuses.map((status, dayIndex) => <span key={dayIndex} className="h-1.5 min-w-0 flex-1 rounded-full" style={{ backgroundColor: statusColor[status] }} />)}</div><p className="mt-1.5 whitespace-nowrap text-center text-[9px] font-bold text-[var(--dim)]">W{week.weekNumber} ({week.arrows})</p></div>)}
    </div>
    <div className="mt-4 grid grid-cols-2 divide-x divide-[var(--border)] border-t border-[var(--border)] pt-3 text-center"><div><p className="text-xl font-extrabold">{total}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Total arrows</p></div><div><p className="text-xl font-extrabold">{formatAverage(average)}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Average / week</p></div></div>
  </section>;
}

function CycleHistoryModal({ summaries, onClose }: { summaries: Tracker["cycleSummaries"]; onClose: () => void }) {
  useEscapeToClose(onClose);
  const ordered = [...summaries].sort((a, b) => b.cycle - a.cycle);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="cycle-history-title" onClick={onClose}>
    <article className="max-h-[90dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Completed six-week blocks</p><h2 id="cycle-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Cycle history</h2></div><button type="button" onClick={onClose} aria-label="Close cycle history" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {ordered.length === 0 ? <p className="py-12 text-center text-sm text-[var(--dim)]">Your first completed cycle will appear here.</p> : <div className="mt-5 space-y-3">{ordered.map((summary) => <CycleSummaryCard key={summary.cycle} summary={summary} />)}</div>}
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}

// ---------------------------------------------------------------------------
// Planned session details modal (shared: own data, or an athlete's when the
// coach passes `athleteId`, which routes mutations through the coach endpoints)
// ---------------------------------------------------------------------------

function PlannedSessionModal({ session, onClose, onSaved, athleteId }: { session: PlannedSession; onClose: () => void; onSaved: () => void; athleteId?: string }) {
  const [draft, setDraft] = useState<PlannedSessionDraft>({ dayKey: session.dayKey, sessionType: session.sessionType, detail: session.detail, prescription: session.prescription });
  const [editing, setEditing] = useState(false);
  const [sptWorkoutOpen, setSptWorkoutOpen] = useState(false);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [message, setMessage] = useState("");
  useEscapeToClose(onClose);
  const save = useMutation({
    mutationFn: () => athleteId ? api.coachSavePlannedSession(athleteId, draft) : api.savePlannedSession(draft),
    onSuccess: () => { onSaved(); setEditing(false); setMessage("Session updated"); },
    onError: () => setMessage("Couldn’t update this session. Try again."),
  });
  const addLink = useMutation({
    mutationFn: () => athleteId
      ? api.coachAddPlannedSessionLink(athleteId, { dayKey: session.dayKey, label: linkLabel.trim(), url: linkUrl.trim() })
      : api.addPlannedSessionLink({ dayKey: session.dayKey, label: linkLabel.trim(), url: linkUrl.trim() }),
    onSuccess: () => { onSaved(); setLinkLabel(""); setLinkUrl(""); setMessage("Link added"); },
    onError: () => setMessage("Couldn’t add that link. Check the address and try again."),
  });
  const addFile = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 8_000_000) throw new Error("too-large");
      const encoded = await fileToBase64(file);
      const args = { dayKey: session.dayKey, kind: (file.type.startsWith("image/") ? "photo" : "document") as "document" | "photo", label: file.name, mimeType: encoded.mimeType || "application/octet-stream", dataBase64: encoded.dataBase64 };
      return athleteId ? api.coachAddPlannedSessionFile(athleteId, args) : api.addPlannedSessionFile(args);
    },
    onSuccess: () => { onSaved(); setMessage("Attachment added"); },
    onError: (error) => setMessage(error instanceof Error && error.message === "too-large" ? "Choose a file smaller than 8 MB." : "Couldn’t add that file. Try again."),
  });
  const removeAttachment = useMutation({
    mutationFn: (id: number) => athleteId ? api.coachDeletePlannedSessionAttachment(athleteId, id) : api.deletePlannedSessionAttachment({ id }),
    onSuccess: () => { onSaved(); setMessage("Attachment removed"); },
    onError: () => setMessage("Couldn’t remove that attachment."),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (draft.sessionType.trim() && draft.detail.trim() && draft.prescription.trim()) save.mutate(); };
  const hasSptPdf = session.dayKey === "wed";
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="planned-session-title" onClick={onClose}>
    <article className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{session.day} plan</p><h2 id="planned-session-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">{session.sessionType}</h2></div><button type="button" onClick={onClose} aria-label="Close planned session" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {editing ? <form onSubmit={submit} className="mt-5 space-y-4">
        <label><span className="label">Activity</span><input autoFocus className="field" aria-label="Planned activity name" value={draft.sessionType} maxLength={80} onChange={(event) => setDraft({ ...draft, sessionType: event.target.value })} required /></label>
        <label><span className="label">Summary</span><input className="field" aria-label="Planned session summary" value={draft.detail} maxLength={200} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} required /></label>
        <label><span className="label">Session details</span><textarea className="field min-h-32 resize-y leading-6" aria-label="Planned session details" value={draft.prescription} maxLength={3000} onChange={(event) => setDraft({ ...draft, prescription: event.target.value })} required /></label>
        <div className="flex gap-2"><button type="button" onClick={() => { setDraft({ dayKey: session.dayKey, sessionType: session.sessionType, detail: session.detail, prescription: session.prescription }); setEditing(false); setMessage(""); }} className="flex-1 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={save.isPending} className="flex-[2] rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{save.isPending ? "Saving…" : "Save changes"}</button></div>
      </form> : <div className="mt-5">
        <div className="flex items-start justify-between gap-4"><div><p className="text-lg font-bold">{session.detail}</p><p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--dim)]">{session.prescription}</p></div><button type="button" onClick={() => { setEditing(true); setMessage(""); }} aria-label={`Edit ${session.day} planned session`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)]"><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div>
      </div>}
      <section className="mt-6 border-t border-[var(--border)] pt-5" aria-labelledby="planned-session-attachments"><div className="flex items-baseline justify-between gap-3"><div><h3 id="planned-session-attachments" className="section-title">Attachments</h3><p className="mt-1 text-xs text-[var(--dim)]">Documents, photos, and reference links</p></div><label className="cursor-pointer rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]"><span>{addFile.isPending ? "Uploading…" : "+ File or photo"}</span><input className="sr-only" type="file" accept="image/*,.pdf,.doc,.docx,.txt,.rtf" disabled={addFile.isPending} aria-label="Add a document or photo" onChange={(event) => { const file = event.target.files?.[0]; if (file) addFile.mutate(file); event.currentTarget.value = ""; }} /></label></div>
        <div className="mt-4 space-y-2">
          {hasSptPdf && <div className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] p-3"><span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface)] text-[10px] font-black text-[var(--accent)]">PDF</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">Wednesday SPT band workout</p><p className="text-xs text-[var(--dim)]">Original workout · 2 pages</p></div><button type="button" onClick={() => setSptWorkoutOpen(true)} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)]">Open</button></div>}
          {session.attachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] p-3"><span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface)] text-[10px] font-black uppercase text-[var(--accent)]">{attachment.kind === "photo" ? "IMG" : attachment.kind === "link" ? "URL" : "DOC"}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{attachment.label}</p><p className="text-xs capitalize text-[var(--dim)]">{attachment.kind}</p></div><SafeLink url={attachment.url} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)]">Open</SafeLink><button type="button" disabled={removeAttachment.isPending} onClick={() => removeAttachment.mutate(attachment.id)} aria-label={`Remove ${attachment.label}`} className="shrink-0 rounded-lg px-2 py-2 text-xs font-bold text-[var(--dim)]">Remove</button></div>)}
          {!hasSptPdf && session.attachments.length === 0 && <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--dim)]">No attachments yet.</p>}
        </div>
        <form className="mt-4 space-y-2" onSubmit={(event) => { event.preventDefault(); if (linkLabel.trim() && linkUrl.trim()) addLink.mutate(); }}><p className="label">Add a link</p><input className="field" aria-label="Link label" value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Name this reference" maxLength={160} /><div className="flex gap-2"><input className="field min-w-0" aria-label="Link address" type="url" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://…" required /><button type="submit" disabled={addLink.isPending || !linkLabel.trim() || !linkUrl.trim()} className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-45">{addLink.isPending ? "Adding…" : "Add"}</button></div></form>
      </section>
      {message && <p role="status" className="mt-3 text-center text-xs font-semibold text-[var(--dim)]">{message}</p>}
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[#17372a] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
    {sptWorkoutOpen && <div className="absolute inset-0 z-10 flex flex-col bg-[var(--bg)] text-[var(--text)]" role="dialog" aria-modal="true" aria-labelledby="spt-workout-title" onClick={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-safe">
        <div className="min-w-0"><p className="text-xs font-semibold text-[var(--dim)]">Wednesday SPT · 2 pages</p><h2 id="spt-workout-title" className="truncate text-base font-extrabold">Band workout</h2></div>
        <button type="button" onClick={() => setSptWorkoutOpen(false)} aria-label="Close SPT workout" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#e8ecef] px-2 py-3 sm:px-5">
        <div className="mx-auto max-w-3xl space-y-3">
          <img src={sptWorkoutPageOne} alt="Wednesday SPT band workout, page 1 of 2: core resistance band routine exercises 1 through 5" className="block h-auto w-full bg-white shadow-sm" />
          <img src={sptWorkoutPageTwo} alt="Wednesday SPT band workout, page 2 of 2: exercises 6 through 8 and Holding Song instructions" className="block h-auto w-full bg-white shadow-sm" />
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-safe pt-3"><button type="button" onClick={() => setSptWorkoutOpen(false)} className="w-full rounded-xl bg-[#17372a] px-4 py-3 text-sm font-extrabold text-white">Back to session</button></div>
    </div>}
  </div>;
}

function Dashboard({ data, onLog, onSaved }: { data: Tracker; onLog: () => void; onSaved: () => void }) {
  const [selectedSessionKey, setSelectedSessionKey] = useState<PlanDayKey | null>(null);
  const now = new Date();
  const todayKey = localDate();
  const weekMonday = mondayOf(now);
  const sessionDates = new Set(data.sessions.map((session) => session.sessionDate));
  const statusFor = (date: Date): TrainingDayStatus => {
    const key = dateKey(date);
    if (sessionDates.has(key)) return "completed";
    return key < todayKey ? "skipped" : "upcoming";
  };
  const plannedSessions = plannedSessionsFor(data);
  const currentWeekDays = plannedSessions.slice(0, 6).map((day, index) => {
    const date = addDays(weekMonday, index);
    return { date: dateKey(date), label: day.short, status: statusFor(date) };
  });
  const currentCycleSummary = data.cycleSummaries.find((summary) => summary.cycle === data.state.currentCycle);
  const cycleStart = addDays(weekMonday, -(Math.max(1, Math.min(6, data.state.currentWeek)) - 1) * 7);
  const cycleWeeks = currentCycleSummary?.weeks ?? Array.from({ length: 6 }, (_, weekIndex) => ({
    weekNumber: weekIndex + 1,
    weekStart: dateKey(addDays(cycleStart, weekIndex * 7)),
    arrows: 0,
    dayStatuses: Array.from({ length: 6 }, (_unused, dayIndex) => statusFor(addDays(cycleStart, (weekIndex * 7) + dayIndex))),
  }));
  const cycleTotal = cycleWeeks.reduce((sum, week) => sum + week.arrows, 0);
  const cycleAverage = cycleTotal / Math.max(1, data.state.currentWeek);
  const today = plannedSessions[(now.getDay() + 6) % 7] ?? plannedSessions[0]!;
  const selectedSession = plannedSessions.find((session) => session.dayKey === selectedSessionKey) ?? null;
  const focus = cyclePlanFor(data).find((week) => week.weekNumber === data.state.currentWeek)?.primaryFocus ?? "Release";
  const next = milestones.find((m) => m.weight > data.state.currentPoundage) ?? milestones[milestones.length - 1]!;
  const weekArrows = data.weeklyArrows.at(-1)?.arrows ?? 0;
  return <div className="space-y-5">
    <section className="overflow-hidden rounded-[18px] bg-[#17372a] p-5 text-white shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 pt-1"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#a9d2bb]">Cycle {data.state.currentCycle}, Week {data.state.currentWeek}</p><p className="mt-2 text-3xl font-extrabold tracking-tight">{focus}</p><p className="mt-1 text-sm text-[#c7dbcf]">Primary technical focus</p></div>
        <WeeklySessionRing days={currentWeekDays} onLog={onLog} completedToday={sessionDates.has(todayKey)} />
      </div>
      <div className="mt-5 border-t border-white/15 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3"><p className="text-xs font-bold text-white">Current cycle</p><p className="text-[10px] font-semibold text-[#a9d2bb]">6 weeks · 36 training days</p></div>
        <div role="img" aria-label={`Six-week cycle progress. ${cycleWeeks.flatMap((week) => week.dayStatuses).filter((status) => status === "completed").length} completed, ${cycleWeeks.flatMap((week) => week.dayStatuses).filter((status) => status === "skipped").length} skipped. ${cycleWeeks.map((week) => `Week ${week.weekNumber}: ${week.arrows} arrows`).join(", ")}.`} className="grid grid-cols-6 gap-2">
          {cycleWeeks.map((week) => <div key={week.weekNumber} className="min-w-0"><div className="flex gap-[2px]">{week.dayStatuses.map((status, dayIndex) => <span key={dayIndex} className="h-1.5 min-w-0 flex-1 rounded-full" style={{ backgroundColor: statusColor[status] }} />)}</div><p className={`mt-1.5 whitespace-nowrap text-center text-[9px] font-bold ${week.weekNumber === data.state.currentWeek ? "text-white" : "text-[#88a093]"}`}>W{week.weekNumber} ({week.arrows})</p></div>)}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-semibold text-[#c7dbcf]">{(["completed", "skipped", "upcoming"] as TrainingDayStatus[]).map((status) => <span key={status} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusColor[status] }} />{status[0]?.toUpperCase()}{status.slice(1)}</span>)}</div>
        <div className="mt-4 grid grid-cols-2 divide-x divide-white/15 border-t border-white/15 pt-3 text-center"><div><p className="text-xl font-extrabold">{cycleTotal}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[#a9d2bb]">Cycle arrows</p></div><div><p className="text-xl font-extrabold">{formatAverage(cycleAverage)}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[#a9d2bb]">Average / week</p></div></div>
      </div>
    </section>
    <section><div className="mb-2 flex items-center justify-between"><h2 className="section-title">Today · {today.day}</h2><button type="button" onClick={onLog} className="text-sm font-bold text-[var(--accent)]">Log session</button></div><button type="button" onClick={() => setSelectedSessionKey(today.dayKey)} className="card block w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open and edit today’s ${today.sessionType} session`}><div className="flex items-start justify-between gap-3"><div><p className="text-lg font-bold">{today.sessionType}</p><p className="text-sm text-[var(--dim)]">{today.detail}</p></div><span className="rounded-full bg-[var(--green-soft)] px-2.5 py-1 text-xs font-bold text-[var(--green)]">Scheduled</span></div><p className="mt-3 border-t border-[var(--border)] pt-3 text-sm leading-6">{today.prescription}</p><p className="mt-3 text-xs font-bold text-[var(--accent)]">View details & attachments <span aria-hidden="true">→</span></p></button></section>
    <div className="grid grid-cols-2 gap-3"><div className="card p-4"><p className="text-2xl font-extrabold">{weekArrows}</p><p className="text-xs text-[var(--dim)]">arrows this logged week</p></div><div className="card p-4"><p className="text-2xl font-extrabold">{data.sessions.length}</p><p className="text-xs text-[var(--dim)]">sessions recorded</p></div></div>
    <section><h2 className="section-title mb-2">Next milestone</h2><div className="card p-4"><div className="flex items-baseline justify-between"><p className="text-lg font-bold">{next.weight} lb</p><p className="text-xs font-semibold text-[var(--accent)]">{next.target}</p></div><p className="mt-1 text-sm text-[var(--dim)]">{next.note}</p></div></section>
    <section><h2 className="section-title mb-2">Recent sessions</h2>{data.sessions.length === 0 ? <Empty>No sessions yet. Your first log will appear here.</Empty> : <div className="card divide-y divide-[var(--border)]">{data.sessions.slice(0, 4).map((s) => <div key={s.id} className="flex items-center justify-between gap-3 p-4"><div><p className="font-bold">{sessionLabel(s)} <span className="font-normal text-[var(--dim)]">· {s.focus || "General work"}</span></p><p className="mt-0.5 text-xs text-[var(--dim)]">{formatDate(s.sessionDate)} · {s.durationMinutes} min</p></div><strong className="text-sm">{s.arrows ? `${s.arrows} arr.` : "—"}</strong></div>)}</div>}</section>
    <Inspiration inspiration={data.inspiration} />
    {selectedSession && <PlannedSessionModal key={selectedSession.dayKey} session={selectedSession} onClose={() => setSelectedSessionKey(null)} onSaved={onSaved} />}
  </div>;
}

function Inspiration({ inspiration }: { inspiration: Tracker["inspiration"] }) {
  if (!inspiration) return <section><h2 className="section-title mb-2">Inspiration</h2><Empty>Your next daily check-in will appear here.</Empty></section>;
  const video = normalizeVideoSource(inspiration.videoUrl);
  const updated = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(inspiration.updatedAt));
  return <section aria-labelledby="inspiration-heading" className="space-y-3">
    <div className="flex items-end justify-between gap-3"><h2 id="inspiration-heading" className="section-title">Inspiration</h2><p className="text-xs text-[var(--dim)]">Updated {updated}</p></div>
    <article className="card p-5"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Thought for the day</p><blockquote className="mt-3 text-lg font-semibold leading-7 tracking-[-.01em]">{inspiration.thoughtText}</blockquote></article>
    <article className="card overflow-hidden">
      {video ? <InlineVideo video={video} title={inspiration.videoTitle} /> : <div className="flex aspect-video items-center justify-center bg-[var(--surface-2)] px-6 text-center text-sm text-[var(--dim)]">Inline playback isn’t available for this source.</div>}
      <div className="flex items-start justify-between gap-3 p-4"><div><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Watch</p><h3 className="mt-1 font-bold leading-6">{inspiration.videoTitle}</h3></div><SafeLink url={video?.sourceUrl ?? inspiration.videoUrl} className="shrink-0 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold text-[var(--text)]">Open on {video?.provider ?? "source"}</SafeLink></div>
    </article>
    <article className="card p-5"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--accent)]">Power meal</p><h3 className="mt-2 text-xl font-extrabold tracking-[-.02em]">{inspiration.recipeName}</h3><p className="mt-2 text-sm leading-6 text-[var(--dim)]">{inspiration.recipeSummary}</p><div className="mt-4 border-t border-[var(--border)] pt-4"><p className="text-xs font-bold uppercase tracking-wider text-[var(--dim)]">Ingredients</p><p className="mt-1 whitespace-pre-line text-sm leading-6">{inspiration.recipeIngredients}</p></div></article>
  </section>;
}

// ---------------------------------------------------------------------------
// Score tracking, training log, weekly notes
// ---------------------------------------------------------------------------

type ScoreDraft = (number | null)[][];
const emptyScoreDraft = (): ScoreDraft => Array.from({ length: 10 }, () => [null, null, null]);
const formatAverage = (value: number) => value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

function PracticeScoreEntry({ score, onOpen, onShare }: { score: PracticeScore; onOpen: () => void; onShare: () => void }) {
  return <article className="card p-4">
    <button type="button" onClick={onOpen} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open practice score from ${formatDate(score.scoreDate)}, ${score.total} out of 300`}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-bold">Practice score · {formatDate(score.scoreDate)}</p><p className="mt-1 text-xs text-[var(--dim)]">10 ends · 30 arrows</p></div>
        <div className="text-right"><p className="text-xl font-extrabold text-[var(--accent)]">{score.total}<span className="text-xs font-bold text-[var(--dim)]"> / 300</span></p><p className="mt-0.5 text-[11px] font-semibold text-[var(--dim)]">View details →</p></div>
      </div>
    </button>
    <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t border-[var(--border)] pt-3">
      <div><p className="text-[11px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Avg arrow</p><p className="mt-0.5 text-sm font-extrabold">{formatAverage(score.averageArrow)}</p></div>
      <div><p className="text-[11px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Avg end</p><p className="mt-0.5 text-sm font-extrabold">{formatAverage(score.averageEnd)}</p></div>
      <ShareButton label={`Share practice score from ${formatDate(score.scoreDate)}`} onClick={onShare} />
    </div>
  </article>;
}

function PracticeScoreModal({ score, onClose, onDelete, deleting }: { score: PracticeScore; onClose: () => void; onDelete: () => void; deleting: boolean }) {
  useEscapeToClose(onClose);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="practice-score-details-title" onClick={onClose}>
    <article className="score-modal-scroll max-h-[92dvh] min-w-0 w-full max-w-full overflow-x-hidden overflow-y-auto overscroll-x-none rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:px-5 sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{formatDate(score.scoreDate)} · 30 arrows</p><h2 id="practice-score-details-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Practice score</h2></div><button type="button" onClick={onClose} aria-label="Close practice score details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <div className="mt-5 grid grid-cols-3 divide-x divide-[var(--border)] rounded-xl bg-[var(--surface-2)] py-3 text-center"><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Total</p><p className="mt-1 text-lg font-extrabold">{score.total}/300</p></div><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Avg arrow</p><p className="mt-1 text-lg font-extrabold">{formatAverage(score.averageArrow)}</p></div><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Avg end</p><p className="mt-1 text-lg font-extrabold">{formatAverage(score.averageEnd)}</p></div></div>
      <div className="mt-5 min-w-0">
        <div className="score-grid px-2 pb-2 text-[10px] font-bold uppercase tracking-[.04em] text-[var(--dim)]"><span>End</span><span>A1</span><span>A2</span><span>A3</span><span>Total</span><span>Avg</span></div>
        <div className="divide-y divide-[var(--border)]">{score.ends.map((end) => <div key={end.endNumber} className="score-grid px-2 py-2.5 text-center text-sm"><strong>{end.endNumber}</strong>{end.arrows.map((arrow, index) => <span key={index}>{arrow}</span>)}<strong>{end.total}</strong><span className="text-[var(--dim)]">{formatAverage(end.averageArrow)}</span></div>)}</div>
      </div>
      <div className="mt-5 flex gap-2"><button type="button" disabled={deleting} onClick={onDelete} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--dim)] disabled:opacity-50">{deleting ? "Deleting…" : "Delete"}</button><button type="button" onClick={onClose} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button></div>
    </article>
  </div>;
}

function ScoreEntryModal({ onClose, onSave, saving, error }: { onClose: () => void; onSave: (date: string, ends: [number, number, number][]) => void; saving: boolean; error: string }) {
  const [date, setDate] = useState(localDate());
  const [ends, setEnds] = useState<ScoreDraft>(emptyScoreDraft);
  useEscapeToClose(onClose);
  const values = ends.flat();
  const entered = values.filter((value): value is number => value !== null);
  const total = entered.reduce((sum, value) => sum + value, 0);
  const complete = entered.length === 30;
  const updateArrow = (endIndex: number, arrowIndex: number, raw: string) => {
    const parsed = raw === "" ? null : Math.max(0, Math.min(10, Number(raw)));
    setEnds((current) => current.map((end, index) => index === endIndex ? end.map((value, indexWithinEnd) => indexWithinEnd === arrowIndex ? parsed : value) : end));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete) return;
    onSave(date, ends.map((end) => [end[0] ?? 0, end[1] ?? 0, end[2] ?? 0]));
  };
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="practice-score-title" onClick={onClose}>
    <form onSubmit={submit} className="score-modal-scroll max-h-[94dvh] min-w-0 w-full max-w-full overflow-x-hidden overflow-y-auto overscroll-x-none rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:px-5 sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">10 ends · 3 arrows each</p><h2 id="practice-score-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Record practice score</h2></div><button type="button" onClick={onClose} aria-label="Close score entry" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <label className="mt-4 block"><span className="label">Date</span><input className="field" aria-label="Practice score date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
      <div className="mt-4 rounded-xl bg-[#17372a] px-4 py-3 text-white"><div className="grid grid-cols-3 divide-x divide-white/15 text-center"><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Total</p><p className="mt-1 text-xl font-extrabold">{total}<span className="text-xs text-[#a9d2bb]"> / 300</span></p></div><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Avg arrow</p><p className="mt-1 text-xl font-extrabold">{entered.length ? formatAverage(total / entered.length) : "—"}</p></div><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Entered</p><p className="mt-1 text-xl font-extrabold">{entered.length}<span className="text-xs text-[#a9d2bb]"> / 30</span></p></div></div></div>
      <div className="mt-5"><div className="score-entry-grid px-1 pb-2 text-center text-[10px] font-bold uppercase tracking-[.04em] text-[var(--dim)]"><span>End</span><span>Arrow 1</span><span>Arrow 2</span><span>Arrow 3</span><span>Total</span><span>Avg</span></div><div className="divide-y divide-[var(--border)]">{ends.map((end, endIndex) => {
        const filled = end.filter((value): value is number => value !== null);
        const endTotal = filled.reduce((sum, value) => sum + value, 0);
        return <div key={endIndex} className="score-entry-grid items-center px-1 py-2"><strong className="text-center text-sm">{endIndex + 1}</strong>{end.map((value, arrowIndex) => <input key={arrowIndex} className="score-arrow" aria-label={`End ${endIndex + 1}, arrow ${arrowIndex + 1}`} type="number" min="0" max="10" inputMode="numeric" value={value ?? ""} onChange={(event) => updateArrow(endIndex, arrowIndex, event.target.value)} />)}<strong className="text-center text-sm">{filled.length ? endTotal : "—"}</strong><span className="text-center text-xs text-[var(--dim)]">{filled.length ? formatAverage(endTotal / filled.length) : "—"}</span></div>;
      })}</div></div>
      {!complete && <p className="mt-3 text-center text-xs text-[var(--dim)]">Enter all 30 arrow values to save.</p>}{error && <p role="alert" className="mt-3 text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
      <div className="sticky bottom-0 -mx-4 mt-4 flex gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-3 sm:-mx-5 sm:px-5"><button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={!complete || saving} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-45">{saving ? "Saving…" : `Save ${total}/300`}</button></div>
    </form>
  </div>;
}

function ArrowHistoryModal({ weeklyArrows, onClose }: { weeklyArrows: Tracker["weeklyArrows"]; onClose: () => void }) {
  useEscapeToClose(onClose);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="arrow-history-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Last 8 logged weeks</p><h2 id="arrow-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Arrows by week</h2></div><button type="button" onClick={onClose} aria-label="Close arrows by week chart" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {weeklyArrows.length === 0 ? <p className="py-12 text-center text-sm text-[var(--dim)]">The chart starts with your first range log.</p> : <div className="mt-5 h-56 w-full" aria-label="Weekly arrows bar chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={weeklyArrows} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}><CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="week" tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }} /><Bar dataKey="arrows" name="Arrows" fill="var(--accent)" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}

function WeeklyNotesCard({ note, onSaved }: { note: Tracker["currentWeeklyNote"]; onSaved: () => void }) {
  const [text, setText] = useState(note.notes);
  const [status, setStatus] = useState("");
  useEffect(() => {
    setText(note.notes);
    setStatus("");
  }, [note.weekStart]);
  const save = useMutation({
    mutationFn: () => api.saveWeeklyNote({ today: localDate(), notes: text }),
    onSuccess: () => { onSaved(); setStatus("Saved"); },
    onError: () => setStatus("Couldn’t save. Try again."),
  });
  const dirty = text !== note.notes;
  return <section className="card p-4" aria-labelledby="weekly-notes-heading">
    <div className="flex items-start justify-between gap-3"><div><h2 id="weekly-notes-heading" className="section-title">Weekly notes</h2><p className="mt-1 text-xs text-[var(--dim)]">Week of {formatDate(note.weekStart)}</p></div><div className="flex min-h-8 items-center gap-2">{status && <span role="status" className="text-xs font-semibold text-[var(--dim)]">{status}</span>}<button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{save.isPending ? "Saving…" : "Save"}</button></div></div>
    <textarea className="field mt-3 min-h-32 resize-y leading-6" aria-label="Notes for this week" value={text} maxLength={8000} onChange={(event) => { setText(event.target.value); setStatus(""); }} placeholder="What changed this week? What felt strong? What should carry forward?" />
    <p className="mt-2 text-xs leading-5 text-[var(--dim)]">At the start of next week, these notes move into History and a fresh page opens here.</p>
  </section>;
}

function EditSessionModal({ session, onClose, onSave, saving, error }: { session: TrainingSession; onClose: () => void; onSave: (values: Parameters<typeof api.updateSession>[0]) => void; saving: boolean; error: string }) {
  const [draft, setDraft] = useState({
    sessionDate: session.sessionDate,
    sessionType: session.sessionType,
    customActivity: session.customActivity,
    arrows: session.arrows,
    durationMinutes: session.durationMinutes,
    focus: session.focus,
    score: session.score,
    notes: session.notes,
  });
  useEscapeToClose(onClose);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ id: session.id, ...draft, customActivity: draft.sessionType === "Other" ? draft.customActivity : "" });
  };
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="edit-session-title" onClick={onClose}>
    <form onSubmit={submit} className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Training history</p><h2 id="edit-session-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Edit session</h2></div><button type="button" onClick={onClose} aria-label="Close session editor" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <label><span className="label">Date</span><input className="field" aria-label="Edit session date" type="date" value={draft.sessionDate} onChange={(event) => setDraft({ ...draft, sessionDate: event.target.value })} required /></label>
        <label><span className="label">Session</span><select className="field" aria-label="Edit session type" value={draft.sessionType} onChange={(event) => setDraft({ ...draft, sessionType: event.target.value as SessionType })}>{["Range", "Gym", "SPT", "Class", "Other"].map((value) => <option key={value}>{value}</option>)}</select></label>
        {draft.sessionType === "Other" && <label className="col-span-2"><span className="label">Activity name</span><input className="field" aria-label="Edit activity name" value={draft.customActivity} maxLength={80} onChange={(event) => setDraft({ ...draft, customActivity: event.target.value })} required /></label>}
        <label><span className="label">Arrows</span><input className="field" aria-label="Edit arrows shot" type="number" min="0" max="1000" inputMode="numeric" value={draft.arrows} onChange={(event) => setDraft({ ...draft, arrows: Number(event.target.value) })} /></label>
        <label><span className="label">Duration</span><input className="field" aria-label="Edit duration in minutes" type="number" min="0" max="1440" inputMode="numeric" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label>
      </div>
      <label className="mt-3 block"><span className="label">Focus</span><input className="field" aria-label="Edit training focus" value={draft.focus} maxLength={200} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} /></label>
      <label className="mt-3 block"><span className="label">Score</span><input className="field" aria-label="Edit score" value={draft.score} maxLength={100} placeholder="Optional, e.g. 278/300" onChange={(event) => setDraft({ ...draft, score: event.target.value })} /></label>
      <label className="mt-3 block"><span className="label">Notes</span><textarea className="field min-h-24 resize-y" aria-label="Edit session notes" value={draft.notes} maxLength={3000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
      {error && <p role="alert" className="mt-3 text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
      <div className="sticky bottom-0 -mx-4 mt-5 flex gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-3 sm:-mx-5 sm:px-5"><button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={saving} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button></div>
    </form>
  </div>;
}

function TrainingLog({ data, onSaved, openOnArrival = false }: { data: Tracker; onSaved: () => void; openOnArrival?: boolean }) {
  const [date, setDate] = useState(localDate());
  const [type, setType] = useState<SessionType>(() => prescribedType(localDate()));
  const [open, setOpen] = useState(openOnArrival || data.sessions.length === 0);
  const [scoreEntryOpen, setScoreEntryOpen] = useState(false);
  const [arrowHistoryOpen, setArrowHistoryOpen] = useState(false);
  const [selectedScore, setSelectedScore] = useState<PracticeScore | null>(null);
  const [editingSession, setEditingSession] = useState<TrainingSession | null>(null);
  const [message, setMessage] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [editError, setEditError] = useState("");
  const [scoreError, setScoreError] = useState("");
  useEffect(() => setType(prescribedType(date)), [date]);
  const add = useMutation({ mutationFn: (args: Parameters<typeof api.addSession>[0]) => api.addSession(args), onSuccess: () => { onSaved(); setMessage("Session saved"); setOpen(false); }, onError: () => setMessage("Couldn’t save this session. Try again.") });
  const update = useMutation({ mutationFn: (args: Parameters<typeof api.updateSession>[0]) => api.updateSession(args), onSuccess: () => { onSaved(); setEditingSession(null); setEditError(""); }, onError: () => setEditError("Couldn’t update this session. Try again.") });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteSession({ id }), onSuccess: onSaved });
  const addScore = useMutation({ mutationFn: (args: Parameters<typeof api.addPracticeScore>[0]) => api.addPracticeScore(args), onSuccess: () => { onSaved(); setScoreEntryOpen(false); setScoreError(""); }, onError: () => setScoreError("Couldn’t save this practice score. Try again.") });
  const removeScore = useMutation({ mutationFn: (id: number) => api.deletePracticeScore({ id }), onSuccess: () => { onSaved(); setSelectedScore(null); } });
  function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); add.mutate({ sessionDate: date, sessionType: type, customActivity: type === "Other" ? String(fd.get("customActivity") || "") : "", arrows: Number(fd.get("arrows") || 0), durationMinutes: Number(fd.get("duration") || 0), focus: String(fd.get("focus") || ""), score: String(fd.get("score") || ""), notes: String(fd.get("notes") || "") }); }
  const total = data.weeklyArrows.reduce((sum, w) => sum + w.arrows, 0);
  const timeline = [
    ...data.sessions.map((session) => ({ kind: "session" as const, date: session.sessionDate, createdAt: session.createdAt, item: session })),
    ...data.practiceScores.map((score) => ({ kind: "score" as const, date: score.scoreDate, createdAt: score.createdAt, item: score })),
    ...data.historicalWeeklyNotes.map((note) => ({ kind: "weekly-note" as const, date: note.weekStart, createdAt: note.updatedAt ?? note.weekStart, item: note })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const share = async (text: string) => {
    setShareMessage("");
    try {
      if (navigator.share) {
        await navigator.share({ title: "Do Good Arching", text });
        setShareMessage("Summary shared.");
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setShareMessage("Share sheet isn’t available here, so the summary was copied.");
        return;
      }
      setShareMessage("Sharing isn’t available in this browser.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareMessage("Couldn’t share this summary. Try again.");
    }
  };
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setOpen(!open)} className="rounded-xl bg-[var(--accent)] px-3 py-3 text-sm font-extrabold text-white">{open ? "Close log" : "+ Log training"}</button><button type="button" onClick={() => { setScoreError(""); setScoreEntryOpen(true); }} className="rounded-xl bg-[#17372a] px-3 py-3 text-sm font-extrabold text-white">Score</button></div>
    {open && <form onSubmit={submit} className="card space-y-4 p-4"><div className="grid grid-cols-2 gap-3"><label><span className="label">Date</span><input className="field" aria-label="Session date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label><label><span className="label">Session</span><select className="field" aria-label="Session type" value={type} onChange={(e) => setType(e.target.value as SessionType)}>{["Range", "Gym", "SPT", "Class", "Other"].map((x) => <option key={x}>{x}</option>)}</select></label>{type === "Other" && <label className="col-span-2"><span className="label">Activity name</span><input className="field" name="customActivity" aria-label="Other activity name" maxLength={80} placeholder="e.g. Compound bow, hike, mobility" required autoFocus /></label>}<label><span className="label">Arrows</span><input className="field" name="arrows" aria-label="Arrows shot" type="number" min="0" inputMode="numeric" placeholder="0" /></label><label><span className="label">Duration</span><input className="field" name="duration" aria-label="Duration in minutes" type="number" min="0" inputMode="numeric" placeholder="Minutes" /></label></div><label><span className="label">Focus</span><input className="field" name="focus" aria-label="Training focus" defaultValue={cyclePlanFor(data).find((week) => week.weekNumber === data.state.currentWeek)?.primaryFocus ?? ""} /></label><label><span className="label">Score</span><input className="field" name="score" aria-label="Score" placeholder="Optional, e.g. 278/300" /></label><label><span className="label">Notes</span><textarea className="field min-h-20 resize-y" name="notes" aria-label="Session notes" placeholder="What clicked? What needs work?" /></label><button type="submit" disabled={add.isPending} className="w-full rounded-xl bg-[#17372a] px-4 py-3 font-bold text-white disabled:opacity-60">{add.isPending ? "Saving…" : "Save session"}</button>{message && <p role="status" className="text-center text-xs text-[var(--dim)]">{message}</p>}</form>}
    <button type="button" onClick={() => setArrowHistoryOpen(true)} className="card flex w-full items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open arrows by week chart. ${total} arrows across ${data.weeklyArrows.length} logged weeks`}><div><p className="section-title">Arrows by week</p><p className="mt-1 text-sm text-[var(--dim)]">{total} arrows across {data.weeklyArrows.length} logged {data.weeklyArrows.length === 1 ? "week" : "weeks"}</p></div><span className="shrink-0 text-sm font-bold text-[var(--accent)]">View chart →</span></button>
    <WeeklyNotesCard note={data.currentWeeklyNote} onSaved={onSaved} />
    <section><div className="mb-2 flex items-center justify-between gap-3"><h2 className="section-title">History</h2>{shareMessage && <p role="status" className="text-right text-xs font-semibold text-[var(--dim)]">{shareMessage}</p>}</div>{timeline.length === 0 ? <Empty>No training, practice scores, or weekly notes logged yet.</Empty> : <div className="space-y-2">{timeline.map((entry) => entry.kind === "score" ? <PracticeScoreEntry key={`score-${entry.item.id}`} score={entry.item} onOpen={() => setSelectedScore(entry.item)} onShare={() => void share(practiceScoreShareText(entry.item))} /> : entry.kind === "weekly-note" ? <article key={`weekly-note-${entry.item.id ?? entry.item.weekStart}`} className="card p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">Weekly notes</p><p className="mt-1 text-xs text-[var(--dim)]">Week of {formatDate(entry.item.weekStart)}</p></div><ShareButton label={`Share weekly notes from ${formatDate(entry.item.weekStart)}`} onClick={() => void share(weeklyNoteShareText(entry.item))} /></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--dim)]">{entry.item.notes}</p></article> : <article key={`session-${entry.item.id}`} className="card p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{sessionLabel(entry.item)} · {formatDate(entry.item.sessionDate)}</p><p className="mt-1 text-xs text-[var(--dim)]">{entry.item.durationMinutes} min{entry.item.arrows ? ` · ${entry.item.arrows} arrows` : ""}{entry.item.score ? ` · Score ${entry.item.score}` : ""}</p></div><div className="flex shrink-0 items-center gap-1"><ShareButton label={`Share ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} onClick={() => void share(sessionShareText(entry.item))} /><button type="button" aria-label={`Edit ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} onClick={() => { setEditError(""); setEditingSession(entry.item); }} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text)]"><PencilIcon /></button><button type="button" aria-label={`Delete ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} disabled={remove.isPending} onClick={() => remove.mutate(entry.item.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--dim)] disabled:opacity-50"><TrashIcon /></button></div></div>{entry.item.focus && <p className="mt-3 text-sm"><strong>Focus:</strong> {entry.item.focus}</p>}{entry.item.notes && <p className="mt-1 text-sm text-[var(--dim)]">{entry.item.notes}</p>}</article>)}</div>}</section>
    {arrowHistoryOpen && <ArrowHistoryModal weeklyArrows={data.weeklyArrows} onClose={() => setArrowHistoryOpen(false)} />}
    {scoreEntryOpen && <ScoreEntryModal onClose={() => setScoreEntryOpen(false)} saving={addScore.isPending} error={scoreError} onSave={(scoreDate, ends) => addScore.mutate({ scoreDate, ends })} />}
    {selectedScore && <PracticeScoreModal score={selectedScore} onClose={() => setSelectedScore(null)} deleting={removeScore.isPending} onDelete={() => removeScore.mutate(selectedScore.id)} />}
    {editingSession && <EditSessionModal key={editingSession.id} session={editingSession} onClose={() => setEditingSession(null)} onSave={(values) => update.mutate(values)} saving={update.isPending} error={editError} />}
  </div>;
}

// ---------------------------------------------------------------------------
// Plan tab: shared plan editor (own data, or an athlete's via `athleteId`),
// milestones, gear, nutrition
// ---------------------------------------------------------------------------

function PlanEditor({ plans, plannedSessions, state, onSaved, athleteId }: {
  plans: CyclePlanItem[];
  plannedSessions: PlannedSession[];
  state: { currentCycle: number; currentWeek: number };
  onSaved: () => void;
  athleteId?: string;
}) {
  const [editing, setEditing] = useState<CyclePlanItem | null>(null);
  const [selectedSessionKey, setSelectedSessionKey] = useState<PlanDayKey | null>(null);
  const [saveError, setSaveError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState("");
  const savePlan = useMutation({
    mutationFn: (plan: CyclePlanItem) => athleteId ? api.coachSaveCycleWeekPlan(athleteId, plan) : api.saveCycleWeekPlan(plan),
    onSuccess: () => { onSaved(); setEditing(null); setSaveError(""); },
    onError: () => setSaveError("Couldn’t save this week. Try again."),
  });
  const adjustSchedule = useMutation({
    mutationFn: (adjustment: "skip" | "forward" | "back") => athleteId
      ? api.coachAdjustSchedule(athleteId, { adjustment, today: localDate() })
      : api.adjustSchedule({ adjustment, today: localDate() }),
    onSuccess: (result) => {
      onSaved();
      setMenuOpen(false);
      setScheduleMessage(result.adjustment === "skip"
        ? "This calendar week is skipped. Your current plan week will carry into next week."
        : `Moved to Cycle ${result.currentCycle}, Week ${result.currentWeek}. Calendar updates will continue from here.`);
    },
    onError: () => setScheduleMessage("Couldn’t adjust the schedule. Try again."),
  });
  const selectedSession = plannedSessions.find((session) => session.dayKey === selectedSessionKey) ?? null;
  const orderedPlans = [...plans].sort((a, b) => ((a.weekNumber - state.currentWeek + 6) % 6) - ((b.weekNumber - state.currentWeek + 6) % 6));
  const saveEditing = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing?.primaryFocus.trim()) savePlan.mutate(editing);
  };
  return <div className="space-y-6"><section><div className="mb-2 flex items-start justify-between gap-3"><div><h2 className="section-title">Six-week technical cycle</h2><p className="mt-1 text-sm font-bold text-[var(--accent)]">Cycle {state.currentCycle}, Week {state.currentWeek}</p><p className="mt-0.5 text-xs text-[var(--dim)]">Updates automatically each Monday</p></div><div className="relative shrink-0"><button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Plan schedule options" aria-expanded={menuOpen} className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-2)] text-2xl font-bold leading-none text-[var(--text)]">⋯</button>{menuOpen && <div role="menu" aria-label="Plan schedule options" className="absolute right-0 top-12 z-20 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl"><p className="px-3 pb-2 pt-1 text-[11px] leading-4 text-[var(--dim)]">Rare adjustments. The plan normally follows the calendar.</p><button type="button" role="menuitem" disabled={adjustSchedule.isPending} onClick={() => adjustSchedule.mutate("skip")} className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-bold hover:bg-[var(--surface-2)] disabled:opacity-50">Skip this calendar week<span className="mt-0.5 block text-xs font-normal text-[var(--dim)]">Carry this plan week into next week</span></button><button type="button" role="menuitem" disabled={adjustSchedule.isPending} onClick={() => adjustSchedule.mutate("forward")} className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-bold hover:bg-[var(--surface-2)] disabled:opacity-50">Move forward one week</button><button type="button" role="menuitem" disabled={adjustSchedule.isPending} onClick={() => adjustSchedule.mutate("back")} className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-bold hover:bg-[var(--surface-2)] disabled:opacity-50">Move back one week</button></div>}</div></div>{scheduleMessage && <p role="status" className="mb-3 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-semibold leading-5">{scheduleMessage}</p>}<div className="space-y-2">{orderedPlans.map((item) => {
      const isCurrent = state.currentWeek === item.weekNumber;
      const isEditing = editing?.weekNumber === item.weekNumber;
      return <article key={item.weekNumber} className={`card p-4 ${isCurrent ? "ring-2 ring-[var(--accent)]" : ""}`}>
        {isEditing && editing ? <form onSubmit={saveEditing} className="space-y-3">
          <div className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-black text-white">{item.weekNumber}</span><div><p className="font-bold">Edit week {item.weekNumber}</p>{isCurrent && <p className="text-xs font-bold text-[var(--accent)]">Current week</p>}</div></div>
          <label><span className="label">Primary focus</span><input autoFocus className="field" aria-label={`Week ${item.weekNumber} primary focus`} value={editing.primaryFocus} onChange={(event) => setEditing({ ...editing, primaryFocus: event.target.value })} required maxLength={120} /></label>
          <label><span className="label">Background focus 1</span><input className="field" aria-label={`Week ${item.weekNumber} background focus 1`} value={editing.backgroundFocusOne} onChange={(event) => setEditing({ ...editing, backgroundFocusOne: event.target.value })} maxLength={160} /></label>
          <label><span className="label">Background focus 2</span><input className="field" aria-label={`Week ${item.weekNumber} background focus 2`} value={editing.backgroundFocusTwo} onChange={(event) => setEditing({ ...editing, backgroundFocusTwo: event.target.value })} maxLength={160} /></label>
          {saveError && <p role="alert" className="text-xs font-semibold text-[var(--accent)]">{saveError}</p>}
          <div className="flex gap-2"><button type="button" onClick={() => { setEditing(null); setSaveError(""); }} className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold">Cancel</button><button type="submit" disabled={savePlan.isPending || !editing.primaryFocus.trim()} className="flex-[2] rounded-lg bg-[#17372a] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{savePlan.isPending ? "Saving…" : "Save week"}</button></div>
        </form> : <div className="flex items-start gap-3"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black ${isCurrent ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)]"}`}>{item.weekNumber}</span><div className="min-w-0 flex-1"><p className="font-bold">{item.primaryFocus}{isCurrent && <span className="ml-2 text-xs text-[var(--accent)]">Current</span>}</p><p className="mt-1 text-xs leading-5 text-[var(--dim)]">Background: {[item.backgroundFocusOne, item.backgroundFocusTwo].filter(Boolean).join(" · ") || "None set"}</p></div><button type="button" onClick={() => { setEditing({ ...item }); setSaveError(""); }} aria-label={`Edit week ${item.weekNumber} plan`} title={`Edit week ${item.weekNumber}`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)]"><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></div>}
      </article>;
    })}</div></section>
    <section><h2 className="section-title mb-2">Weekly rhythm</h2><div className="space-y-2">{plannedSessions.map((session) => <button type="button" key={session.dayKey} onClick={() => setSelectedSessionKey(session.dayKey)} className="card flex w-full items-center gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open and edit ${session.day} ${session.sessionType} plan`}><span className="w-9 shrink-0 text-xs font-black text-[var(--accent)]">{session.short}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{session.detail}</span><span className="mt-0.5 block line-clamp-1 text-xs text-[var(--dim)]">{session.sessionType} · {session.prescription}</span></span><span aria-hidden="true" className="shrink-0 text-[var(--dim)]">→</span></button>)}</div></section>
    {selectedSession && <PlannedSessionModal key={selectedSession.dayKey} session={selectedSession} onClose={() => setSelectedSessionKey(null)} onSaved={onSaved} athleteId={athleteId} />}
  </div>;
}

function TrainingPlan({ data, onSaved, onCheck }: { data: Tracker; onSaved: () => void; onCheck: (key: string, checked: boolean) => void }) {
  return <div className="space-y-6">
    <PlanEditor plans={cyclePlanFor(data)} plannedSessions={plannedSessionsFor(data)} state={data.state} onSaved={onSaved} />
    <section><h2 className="section-title mb-2">Poundage milestones</h2><div className="space-y-3">{milestones.map((m) => <div key={m.weight} className="card p-4"><div className="flex items-baseline justify-between gap-3"><p className="text-xl font-extrabold">{m.weight} lb</p><p className="text-xs font-bold text-[var(--accent)]">{m.target}</p></div><p className="mt-1 text-sm text-[var(--dim)]">{m.note}</p><div className="mt-3 divide-y divide-[var(--border)]">{m.tasks.map((task) => { const key = `${m.weight}:${task}`; return <CheckRow key={key} label={task} checked={data.milestoneChecks[key] ?? false} onChange={(v) => onCheck(key, v)} />; })}</div></div>)}</div></section>
    <aside className="rounded-xl bg-[var(--accent-soft)] p-4 text-sm leading-6"><strong>Load rule:</strong> Deload every fourth week—halve volume and keep form work. A bare-shaft tune is mandatory at every 4 lb increase.</aside>
  </div>;
}

const blankSetup = (poundage: number): Omit<Setup, "id" | "updatedAt"> => ({ poundage, name: `${poundage} lb setup`, limbRiser: "", tillerBolts: "", braceHeight: "", stringTwists: "", nockingPoint: "", centerShot: "", plunger: "", gripNotes: "", stabilizer: "", clickerPosition: "", bareShaft: "", walkBack: "", arrowsInUse: "", sightMarks: {} });
const setupFields: [SetupTextKey, string, string][] = [["limbRiser", "Limbs / riser", "Models, length"], ["tillerBolts", "Tiller bolts", "Turns or measured position"], ["braceHeight", "Brace height", "mm"], ["stringTwists", "String twists", "Count"], ["nockingPoint", "Nocking point", "Height"], ["centerShot", "Center shot", "Position"], ["plunger", "Plunger", "Spring / tension"], ["stabilizer", "Stabilizer", "Long rod, side rods, V-bar"], ["clickerPosition", "Clicker position", "Reference"], ["arrowsInUse", "Arrows in use", "Shaft, spine, point"], ["gripNotes", "Grip notes", "Fit and pressure"], ["bareShaft", "Bare-shaft tune", "Result and date"], ["walkBack", "Walk-back tune", "Result and date"]];
const setupDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

function SetupDetails({ setup, onClose }: { setup: Setup; onClose: () => void }) {
  useEscapeToClose(onClose);
  const populatedFields = setupFields.filter(([key]) => String(setup[key] ?? "").trim());
  const sightMarks = Object.entries(setup.sightMarks).filter(([, value]) => value.trim());
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="setup-details-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{setup.poundage} lb · Updated {setupDate(setup.updatedAt)}</p><h2 id="setup-details-title" className="mt-1 text-2xl font-extrabold leading-8 tracking-[-.02em]">{setup.name}</h2></div><button type="button" onClick={onClose} aria-label="Close setup details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {populatedFields.length ? <dl className="mt-5 divide-y divide-[var(--border)]">{populatedFields.map(([key, label]) => <div key={key as string} className="grid gap-1 py-3 sm:grid-cols-[150px_1fr]"><dt className="text-xs font-bold text-[var(--dim)]">{label}</dt><dd className="whitespace-pre-line text-sm leading-6">{String(setup[key])}</dd></div>)}</dl> : <p className="mt-5 text-sm text-[var(--dim)]">No equipment details have been recorded for this setup yet.</p>}
      {sightMarks.length > 0 && <section className="mt-5 border-t border-[var(--border)] pt-5"><h3 className="section-title">Sight marks</h3><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{sightMarks.map(([distance, value]) => <div key={distance} className="rounded-lg bg-[var(--surface-2)] p-3"><p className="text-xs font-bold text-[var(--dim)]">{distance} m</p><p className="mt-1 font-bold">{value}</p></div>)}</div></section>}
      <button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}

function SetupEditor({ draft, setDraft, onCancel, onSave, saving }: { draft: SetupDraft; setDraft: (draft: SetupDraft) => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  return <form onSubmit={(event) => { event.preventDefault(); onSave(); }} className="card space-y-4 p-4"><div className="grid grid-cols-[1fr_100px] gap-3"><label><span className="label">Sheet name</span><input className="field" aria-label="Setup sheet name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span className="label">Poundage</span><input className="field" aria-label="Setup poundage" type="number" value={draft.poundage} onChange={(event) => setDraft({ ...draft, poundage: Number(event.target.value) })} /></label></div><div className="grid gap-3 sm:grid-cols-2">{setupFields.map(([key, label, hint]) => <label key={key as string}><span className="label">{label}</span><textarea className="field min-h-16 resize-y" aria-label={label} placeholder={hint} value={String(draft[key] ?? "")} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div><fieldset><legend className="section-title mb-2">Sight marks</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[20, 30, 40, 50, 60, 70].map((distance) => <label key={distance}><span className="label">{distance} m</span><input className="field" aria-label={`${distance} metre sight mark`} value={draft.sightMarks[String(distance)] ?? ""} onChange={(event) => setDraft({ ...draft, sightMarks: { ...draft.sightMarks, [distance]: event.target.value } })} /></label>)}</div></fieldset><div className="flex gap-2"><button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={saving} className="flex-[2] rounded-xl bg-[#17372a] px-4 py-3 text-sm font-bold text-white disabled:opacity-60">{saving ? "Saving…" : "Save setup"}</button></div></form>;
}

function BowAndGear({ data, onSaved }: { data: Tracker; onSaved: () => void }) {
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [details, setDetails] = useState<Setup | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<MaintenanceSection | null>(null);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [editingItem, setEditingItem] = useState<{ id: number; label: string } | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const save = useMutation({ mutationFn: (value: SetupDraft) => api.saveSetup(value), onSuccess: () => { onSaved(); setDraft(null); } });
  const duplicate = useMutation({ mutationFn: (args: { id: number; poundage: number }) => api.duplicateSetup(args), onSuccess: onSaved });
  const toggleMaintenance = useMutation({ mutationFn: (args: { id: number; checked: boolean }) => api.setMaintenanceItemChecked(args), onSuccess: onSaved });
  const clearMaintenance = useMutation({ mutationFn: (section: MaintenanceSection) => api.clearMaintenanceSection({ section }), onSuccess: onSaved });
  const addMaintenance = useMutation({
    mutationFn: (args: { section: MaintenanceSection; label: string }) => api.addMaintenanceItem(args),
    onSuccess: () => { onSaved(); setNewItemLabel(""); setMaintenanceMessage("Item added"); },
    onError: () => setMaintenanceMessage("Couldn’t add that item. Try again."),
  });
  const updateMaintenance = useMutation({
    mutationFn: (args: { id: number; label: string }) => api.updateMaintenanceItem(args),
    onSuccess: () => { onSaved(); setEditingItem(null); setMaintenanceMessage("Item updated"); },
    onError: () => setMaintenanceMessage("Couldn’t update that item. Try again."),
  });
  const deleteMaintenance = useMutation({
    mutationFn: (id: number) => api.deleteMaintenanceItem({ id }),
    onSuccess: () => { onSaved(); setEditingItem(null); setMaintenanceMessage("Item removed"); },
    onError: () => setMaintenanceMessage("Couldn’t remove that item. Try again."),
  });
  const sortedSetups = [...data.setups].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const matchingCurrent = sortedSetups.find((setup) => setup.poundage === data.state.currentPoundage);
  const current = matchingCurrent ?? sortedSetups[0] ?? null;
  const history = current ? sortedSetups.filter((setup) => setup.id !== current.id) : [];
  const currentHighlights = current ? [
    { label: "Limbs / riser", value: current.limbRiser },
    { label: "Arrows", value: current.arrowsInUse },
    { label: "Brace height", value: current.braceHeight },
    { label: "Stabilizer", value: current.stabilizer },
    { label: "Clicker", value: current.clickerPosition },
  ].filter((item) => item.value.trim()).slice(0, 3) : [];

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setHistoryOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  return <div className="space-y-7">
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><h2 className="section-title">Current bow setup</h2>{current && <p className="mt-1 text-xs text-[var(--dim)]">Updated {setupDate(current.updatedAt)}</p>}</div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setHistoryOpen(true)} disabled={draft !== null} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold disabled:opacity-45">History{history.length > 0 ? ` (${history.length})` : ""}</button>
          <button type="button" onClick={() => setDraft(blankSetup(data.state.currentPoundage))} disabled={draft !== null} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-45">New</button>
        </div>
      </div>
      {draft ? <SetupEditor draft={draft} setDraft={setDraft} onCancel={() => setDraft(null)} onSave={() => save.mutate(draft)} saving={save.isPending} /> : current ? <div className="card relative overflow-hidden">
        <button type="button" onClick={() => setDetails(current)} className="block w-full p-4 pr-14 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" aria-label={`View full setup details for ${current.name}`}>
          <p className="text-xl font-extrabold">{current.name}</p>
          {currentHighlights.length > 0 ? <dl className="mt-4 grid gap-3 sm:grid-cols-3">{currentHighlights.map((item) => <div key={item.label} className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-[.08em] text-[var(--dim)]">{item.label}</dt><dd className="mt-1 line-clamp-2 text-sm font-semibold leading-5">{item.value}</dd></div>)}</dl> : <p className="mt-2 text-sm text-[var(--dim)]">Tap to review the full setup.</p>}
          <p className="mt-4 text-xs font-bold text-[var(--accent)]">View full setup <span aria-hidden="true">→</span></p>
        </button>
        <button type="button" onClick={() => setDraft(current)} aria-label={`Edit ${current.name}`} title="Edit setup" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)]">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      </div> : <Empty>No bow setup has been saved yet.</Empty>}
      {current && !draft && <button type="button" disabled={duplicate.isPending} onClick={() => duplicate.mutate({ id: current.id, poundage: current.poundage })} className="mt-2 w-full rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-bold text-[var(--dim)] disabled:opacity-50">{duplicate.isPending ? "Duplicating…" : `Duplicate “${current.name}” at ${current.poundage} lb`}</button>}
    </section>

    <section aria-labelledby="maintenance-heading">
      <div className="mb-3"><h2 id="maintenance-heading" className="section-title">Maintenance log</h2><p className="mt-1 text-sm leading-6 text-[var(--dim)]">Tap an item as you finish it. Use the pencil to customize each cadence.</p></div>
      <div className="space-y-3">{maintenanceSections.map((period) => {
        const items = data.maintenanceItems.filter((item) => item.section === period);
        const done = items.filter((item) => item.checked).length;
        const editing = editingSection === period;
        return <article key={period} className="card p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2"><h3 className="text-lg font-extrabold">{period}</h3><span className="text-xs font-bold text-[var(--dim)]">{done}/{items.length}</span></div>
            <div className="flex shrink-0 items-center gap-1.5">
              {done > 0 && <button type="button" disabled={clearMaintenance.isPending} onClick={() => clearMaintenance.mutate(period)} className="rounded-lg px-2.5 py-2 text-xs font-bold text-[var(--accent)] disabled:opacity-50" aria-label={`Clear completed ${period.toLowerCase()} maintenance items`}>Clear</button>}
              <button type="button" onClick={() => { setEditingSection(editing ? null : period); setEditingItem(null); setNewItemLabel(""); setMaintenanceMessage(""); }} aria-label={`${editing ? "Finish editing" : "Edit"} ${period.toLowerCase()} maintenance items`} aria-pressed={editing} className={`flex h-9 w-9 items-center justify-center rounded-full ${editing ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text)]"}`}>
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
            </div>
          </div>
          {items.length === 0 ? <p className="py-3 text-sm text-[var(--dim)]">No items in this section yet.</p> : <div className="divide-y divide-[var(--border)]">{items.map((item) => editingItem?.id === item.id ? <form key={item.id} className="space-y-2 py-3" onSubmit={(event) => { event.preventDefault(); const label = editingItem.label.trim(); if (label) updateMaintenance.mutate({ id: item.id, label }); }}>
            <label><span className="sr-only">Edit {item.label}</span><input autoFocus className="field" value={editingItem.label} onChange={(event) => setEditingItem({ id: item.id, label: event.target.value })} maxLength={160} /></label>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setEditingItem(null)} className="rounded-lg px-3 py-2 text-xs font-bold text-[var(--dim)]">Cancel</button><button type="submit" disabled={updateMaintenance.isPending || !editingItem.label.trim()} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Save</button></div>
          </form> : <div key={item.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><CheckRow label={item.label} checked={item.checked} onChange={(checked) => toggleMaintenance.mutate({ id: item.id, checked })} /></div>
            {editing && <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => setEditingItem({ id: item.id, label: item.label })} className="rounded-lg px-2 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`Edit ${item.label}`}>Edit</button><button type="button" disabled={deleteMaintenance.isPending} onClick={() => deleteMaintenance.mutate(item.id)} className="rounded-lg px-2 py-2 text-xs font-bold text-[var(--dim)] disabled:opacity-50" aria-label={`Delete ${item.label}`}>Delete</button></div>}
          </div>)}</div>}
          {editing && <form className="mt-3 border-t border-[var(--border)] pt-3" onSubmit={(event) => { event.preventDefault(); const label = newItemLabel.trim(); if (label) addMaintenance.mutate({ section: period, label }); }}>
            <label><span className="label">New item</span><div className="flex gap-2"><input className="field min-w-0" value={newItemLabel} onChange={(event) => setNewItemLabel(event.target.value)} placeholder={`Add ${period.toLowerCase()} task`} maxLength={160} aria-label={`New ${period.toLowerCase()} maintenance item`} /><button type="submit" disabled={addMaintenance.isPending || !newItemLabel.trim()} className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Add</button></div></label>
          </form>}
          {editing && maintenanceMessage && <p role="status" className="mt-2 text-xs text-[var(--dim)]">{maintenanceMessage}</p>}
        </article>;
      })}</div>
    </section>

    {details && <SetupDetails setup={details} onClose={() => setDetails(null)} />}
    {historyOpen && <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="setup-history-title" onClick={() => setHistoryOpen(false)}><article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Previous configurations</p><h2 id="setup-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Bow setup history</h2></div><button type="button" onClick={() => setHistoryOpen(false)} aria-label="Close bow setup history" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div><div className="mt-5 divide-y divide-[var(--border)]">{history.length === 0 ? <p className="py-8 text-center text-sm text-[var(--dim)]">Older setups will appear here when you save a new configuration.</p> : history.map((setup) => <div key={setup.id} className="flex items-center justify-between gap-3 py-4"><div><p className="font-bold">{setup.name}</p><p className="mt-0.5 text-xs text-[var(--dim)]">{setup.poundage} lb · Updated {setupDate(setup.updatedAt)}</p></div><button type="button" onClick={() => { setHistoryOpen(false); setDetails(setup); }} className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`View details for ${setup.name}`}>Details</button></div>)}</div><button type="button" onClick={() => setHistoryOpen(false)} className="mt-4 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button></article></div>}
  </div>;
}

function Nutrition({ recipes }: { recipes: Recipe[] }) {
  const [selected, setSelected] = useState<Recipe | null>(null);
  useEscapeToClose(() => { if (selected) setSelected(null); });

  const recipeDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

  return <div className="space-y-3">
    <p className="text-sm leading-6 text-[var(--dim)]">Meals from your daily check-ins, newest first.</p>
    {recipes.length === 0 ? <Empty>Your first daily check-in meal will appear here.</Empty> : recipes.map((recipe) => <article key={recipe.id} className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--dim)]">{recipeDate(recipe.updatedAt)}</p>
          <h2 className="mt-1 text-lg font-bold leading-6">{recipe.name}</h2>
        </div>
        <button type="button" onClick={() => setSelected(recipe)} className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`View full recipe for ${recipe.name}`}>Details</button>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-[var(--dim)]">{recipe.summary}</p>
    </article>)}

    {selected && <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="recipe-title" onClick={() => setSelected(null)}>
      <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-[var(--dim)]">Daily check-in · {recipeDate(selected.updatedAt)}</p>
            <h2 id="recipe-title" className="mt-1 text-2xl font-extrabold leading-8 tracking-[-.02em]">{selected.name}</h2>
          </div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Close recipe details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button>
        </div>
        <section className="mt-5">
          <h3 className="section-title">Overview</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.summary}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Ingredients</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.ingredients}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Method</h3>
          {selected.instructions ? <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.instructions}</p> : <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Method wasn’t saved with this earlier check-in.</p>}
        </section>
        <button type="button" onClick={() => setSelected(null)} className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
      </article>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// Coach team view, athlete overview, settings (export / import / logout)
// ---------------------------------------------------------------------------

function TeamTab() {
  const athletesQuery = useQuery({ queryKey: ["coach-athletes"], queryFn: () => api.listAthletes() });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteMessage, setInviteMessage] = useState("");
  const createInvite = useMutation({
    mutationFn: () => api.createInvite(),
    onSuccess: (result) => {
      setInviteLink(`${window.location.origin}${result.invitePath}`);
      setInviteMessage("");
    },
    onError: () => setInviteMessage("Couldn’t create an invite. Try again."),
  });
  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteMessage("Invite link copied — send it to your athlete.");
    } catch {
      setInviteMessage("Copy didn’t work here — long-press the link to copy it.");
    }
  };
  const selected = athletesQuery.data?.athletes.find((athlete) => athlete.id === selectedId) ?? null;
  return <div className="space-y-5">
    {selected ? <AthleteDetail athlete={selected} onBack={() => setSelectedId(null)} /> : <>
      <section className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="section-title">Invite an athlete</h2><p className="mt-1 text-xs leading-5 text-[var(--dim)]">Single-use link, expires in 24 hours. Share it out-of-band.</p></div>
          <button type="button" disabled={createInvite.isPending} onClick={() => createInvite.mutate()} className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{createInvite.isPending ? "Creating…" : "+ Invite"}</button>
        </div>
        {inviteLink && <div className="mt-3 space-y-2">
          <p className="break-all rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-mono">{inviteLink}</p>
          <button type="button" onClick={copyInviteLink} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold">Copy link</button>
        </div>}
        {inviteMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{inviteMessage}</p>}
      </section>
      <section>
        <h2 className="section-title mb-2">Athletes</h2>
        {athletesQuery.isPending ? <Empty>Loading your team…</Empty>
          : athletesQuery.error ? <div className="card p-4"><p className="text-sm text-[var(--text)]">Your team couldn’t be loaded.</p><button type="button" onClick={() => athletesQuery.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>
          : athletesQuery.data.athletes.length === 0 ? <Empty>No athletes yet. Create an invite above to add your first.</Empty>
          : <div className="space-y-2">{athletesQuery.data.athletes.map((athlete) => <button type="button" key={athlete.id} onClick={() => setSelectedId(athlete.id)} className="card flex w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${athlete.username}’s training overview`}><div className="min-w-0"><p className="font-bold">{athlete.username}</p><p className="mt-0.5 text-xs text-[var(--dim)]">Joined {formatDate(athlete.createdAt.slice(0, 10))}</p></div><span aria-hidden="true" className="shrink-0 text-sm font-bold text-[var(--accent)]">→</span></button>)}</div>}
      </section>
    </>}
  </div>;
}

function AthleteDetail({ athlete, onBack }: { athlete: AthleteSummary; onBack: () => void }) {
  const qc = useQueryClient();
  const today = localDate();
  const [arrowHistoryOpen, setArrowHistoryOpen] = useState(false);
  const overview = useQuery({
    queryKey: ["coach-overview", athlete.id, today],
    queryFn: () => api.athleteOverview(athlete.id, today),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["coach-overview", athlete.id] });
  if (overview.isPending) return <div className="py-8 text-center text-sm text-[var(--dim)]">Loading {athlete.username}’s overview…</div>;
  if (!overview.data || overview.error) return <div className="card p-4"><button type="button" onClick={onBack} className="text-sm font-bold text-[var(--accent)]">← Back to team</button><p className="mt-3 text-sm text-[var(--text)]">This athlete’s overview couldn’t be loaded.</p><button type="button" onClick={() => overview.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>;
  const o = overview.data;
  const totalArrows = o.weeklyArrows.reduce((sum, week) => sum + week.arrows, 0);
  const orderedSummaries = [...o.cycleSummaries].sort((a, b) => b.cycle - a.cycle);
  return <div className="space-y-6">
    <button type="button" onClick={onBack} className="text-sm font-bold text-[var(--accent)]">← Back to team</button>
    <div className="card p-4">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Athlete</p>
      <h2 className="mt-1 text-2xl font-extrabold tracking-[-.02em]">{athlete.username}</h2>
      <p className="mt-1 text-xs text-[var(--dim)]">Cycle {o.state.currentCycle}, Week {o.state.currentWeek} · {o.state.currentPoundage} lb</p>
      <p className="mt-2 text-xs leading-5 text-[var(--dim)]">You can view and edit {athlete.username}’s training plans and summaries. Individual log entries, scores, notes, gear, and check-ins stay private to the athlete.</p>
    </div>
    <PlanEditor plans={cyclePlanFor(o)} plannedSessions={plannedSessionsFor(o)} state={o.state} onSaved={refresh} athleteId={athlete.id} />
    <section>
      <h2 className="section-title mb-2">Arrows by week</h2>
      <button type="button" onClick={() => setArrowHistoryOpen(true)} className="card flex w-full items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${athlete.username}’s arrows by week chart. ${totalArrows} arrows across ${o.weeklyArrows.length} logged weeks`}><div><p className="mt-1 text-sm text-[var(--dim)]">{totalArrows} arrows across {o.weeklyArrows.length} logged {o.weeklyArrows.length === 1 ? "week" : "weeks"}</p></div><span className="shrink-0 text-sm font-bold text-[var(--accent)]">View chart →</span></button>
    </section>
    <section>
      <h2 className="section-title mb-2">Cycle summaries</h2>
      {orderedSummaries.length === 0 ? <Empty>No cycle data yet.</Empty> : <div className="space-y-3">{orderedSummaries.map((summary) => <CycleSummaryCard key={summary.cycle} summary={summary} />)}</div>}
    </section>
    {arrowHistoryOpen && <ArrowHistoryModal weeklyArrows={o.weeklyArrows} onClose={() => setArrowHistoryOpen(false)} />}
  </div>;
}

function SettingsTab({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [exportMessage, setExportMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => { qc.clear(); window.location.reload(); },
  });
  const doExport = async () => {
    setExportMessage("");
    setExporting(true);
    try {
      const payload = await api.exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dga-export-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportMessage("Export downloaded.");
    } catch {
      setExportMessage("Couldn’t export your data. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const handleImportFile = async (file: File) => {
    setImportMessage("");
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { version?: unknown; data?: unknown };
      if (!parsed || parsed.version !== 1 || typeof parsed.data !== "object" || !parsed.data) {
        throw new Error("bad-format");
      }
      const confirmed = window.confirm("Importing replaces ALL of your current training data with this file’s contents. This can’t be undone. Continue?");
      if (!confirmed) return;
      await api.importData(parsed as { version: number; exportedAt: string; username: string; data: Record<string, unknown> });
      await qc.invalidateQueries({ queryKey: ["tracker"] });
      setImportMessage("Import complete — your data was replaced.");
    } catch (error) {
      setImportMessage(error instanceof Error && error.message === "bad-format"
        ? "That file isn’t a Do Good Arching export."
        : "That file couldn’t be imported. Check it’s a Do Good Arching export and try again.");
    } finally {
      setImporting(false);
    }
  };
  return <div className="space-y-5">
    <section className="card p-4">
      <h2 className="section-title">Account</h2>
      <p className="mt-2 text-lg font-extrabold">{me.username}</p>
      <p className="mt-0.5 text-xs capitalize text-[var(--dim)]">{me.role}</p>
    </section>
    <section className="card p-4">
      <h2 className="section-title">Export my data</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Download everything as JSON. File attachments (photos/documents) are not included in the export.</p>
      <button type="button" disabled={exporting} onClick={doExport} className="mt-3 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{exporting ? "Preparing…" : "Download export"}</button>
      {exportMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{exportMessage}</p>}
    </section>
    <section className="card p-4">
      <h2 className="section-title">Import data</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Restore from an export file. This replaces all of your current training data.</p>
      <label className="mt-3 inline-block cursor-pointer rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-bold">
        <span>{importing ? "Importing…" : "Choose export file"}</span>
        <input
          className="sr-only" type="file" accept="application/json,.json" disabled={importing} aria-label="Choose an export file to import"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImportFile(file); event.currentTarget.value = ""; }}
        />
      </label>
      {importMessage && <p role="status" className="mt-2 text-xs font-semibold text-[var(--dim)]">{importMessage}</p>}
    </section>
    <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()} className="w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--dim)] disabled:opacity-50">{logout.isPending ? "Logging out…" : "Log out"}</button>
  </div>;
}
