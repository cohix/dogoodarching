import { useEffect, useState, type ReactNode } from "react";
import { InviteAcceptScreen, AuthScreen } from "./features/auth/AuthScreen";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { api, ApiError, type Me } from "./api";
import { type Tab, type NavItem, coachNav, athleteNav, navGridClass, visibleTab } from "./components/navigation";
import { localDate } from "./lib/dates";
import { resetAccount } from "./lib/account";
import { Dashboard } from "./features/dashboard/Dashboard";
import { TrainingLog } from "./features/log/TrainingLog";
import { TrainingPlan } from "./features/plan/TrainingPlan";
import { BowAndGear } from "./features/gear/BowAndGear";
import { Nutrition } from "./features/fuel/Nutrition";
import { CoachFuel } from "./features/fuel/CoachFuel";
import { CoachToday } from "./features/coach/CoachToday";
import { TeamTab } from "./features/team/TeamTab";
import { SettingsTab } from "./features/settings/SettingsTab";
import { CycleHistoryModal } from "./features/dashboard/CycleHistoryModal";

const inviteTokenFromPath = (): string | null => {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/);
  const encoded = /^\/invite\/?$/.test(window.location.pathname)
    ? window.location.hash.slice(1)
    : match?.[1];
  if (!encoded) return null;
  // Capture before scrubbing both fragment links and legacy path links. The
  // latter have already reached the server once; new fragments never do.
  window.history.replaceState(null, "", "/invite");
  try { return decodeURIComponent(encoded); } catch { return null; }
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
  const meQuery = useQuery<Me | null>({ queryKey: ["me"], queryFn: () => api.me(), retry: false });
  const accountId = meQuery.data?.id;
  useEffect(() => {
    if (!accountId) return;
    // A revoked/deactivated session can first fail on any authenticated read
    // or write. Clear private data and unmount account forms immediately.
    const onError = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) resetAccount(qc);
    };
    const queries = qc.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.query.state.error);
    });
    const mutations = qc.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.mutation.state.error);
    });
    return () => { queries(); mutations(); };
  }, [qc, accountId]);
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
  return <TrackerShell key={meQuery.data.id} me={meQuery.data} />;
}

function TrackerShell({ me }: { me: Me }) {
  return me.role === "coach" ? <CoachShell me={me} /> : <AthleteShell me={me} />;
}

function ShellFrame({ nav, tab, onNavigate, headerAction, children }: { nav: NavItem[]; tab: Tab; onNavigate: (tab: Tab) => void; headerAction?: ReactNode; children: ReactNode }) {
  const title = nav.find((item) => item.id === tab)?.label ?? "Today";
  return <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
    <div aria-hidden="true" className="bg-[var(--bg)] pt-safe" />
    <header className="mx-auto flex max-w-3xl items-end justify-between px-4 pb-4 pt-8">
      <div><p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--accent)]">Do Good Arching</p><h1 className="mt-1 text-3xl font-extrabold tracking-[-.03em]">{title}</h1></div>
      {headerAction}
    </header>
    <main className="mx-auto max-w-3xl px-4 pb-28">{children}</main>
    <nav aria-label="Primary" className={`fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_94%,transparent)] pb-safe backdrop-blur-md`}>
      <div className={`mx-auto grid max-w-3xl px-1 py-2 ${navGridClass(nav)}`}>{nav.map((item) => <button key={item.id} aria-label={item.label} aria-current={tab === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)} className={`min-w-0 rounded-lg px-1 py-1.5 text-center ${tab === item.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--dim)]"}`}><span className="block text-[10px] font-black tracking-widest">{item.mark}</span><span className="block truncate text-[11px] font-semibold">{item.label}</span></button>)}</div>
    </nav>
  </div>;
}

// Coaches have no personal tracker: this shell never requests /api/tracker and
// never mounts Dashboard, TrainingLog, TrainingPlan or BowAndGear.
function CoachShell({ me }: { me: Me }) {
  const [tabState, setTab] = useState<Tab>("dashboard");
  const [teamAthleteId, setTeamAthleteId] = useState<string | null>(null);
  const tab = visibleTab(coachNav, tabState);
  return <ShellFrame nav={coachNav} tab={tab} onNavigate={(next) => { setTeamAthleteId(null); setTab(next); }}>
    {tab === "dashboard" && <CoachToday onOpenAthlete={(athleteId) => { setTeamAthleteId(athleteId); setTab("team"); }} />}
    {tab === "nutrition" && <CoachFuel />}
    {tab === "team" && <TeamTab key={`${me.id}:${me.isOwner}`} me={me} selectedAthleteId={teamAthleteId} onSelectAthlete={setTeamAthleteId} />}
    {tab === "settings" && <SettingsTab me={me} />}
  </ShellFrame>;
}

function AthleteShell({ me }: { me: Me }) {
  const [tabState, setTab] = useState<Tab>("dashboard");
  const [openLogOnArrival, setOpenLogOnArrival] = useState(false);
  const [cycleHistoryOpen, setCycleHistoryOpen] = useState(false);
  const qc = useQueryClient();
  const today = localDate();
  const tracker = useQuery({ queryKey: ["tracker", today], queryFn: () => api.getTracker({ today }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tracker"] });
  const check = useMutation({ mutationFn: (args: { group: "milestone" | "maintenance"; key: string; checked: boolean }) => api.setCheck(args), onSuccess: refresh });
  const tab = visibleTab(athleteNav, tabState);
  if (tracker.isPending) return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe text-sm text-[var(--dim)]">Loading training data…</div>;
  if (!tracker.data || tracker.error) return <div className="min-h-screen bg-[var(--bg)] p-6 pt-safe"><p className="text-sm text-[var(--text)]">Training data couldn’t be loaded.</p><button type="button" className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white" onClick={() => tracker.refetch()}>Try again</button></div>;
  const data = tracker.data;
  const historyButton = tab === "dashboard" ? <button type="button" onClick={() => setCycleHistoryOpen(true)} className="min-h-9 rounded-lg px-2.5 py-1.5 text-xs font-bold text-[var(--accent)]">History</button> : undefined;
  return <ShellFrame nav={athleteNav} tab={tab} headerAction={historyButton} onNavigate={(next) => { setOpenLogOnArrival(false); setTab(next); }}>
    {tab === "dashboard" && <Dashboard data={data} onSaved={refresh} onLog={() => { setOpenLogOnArrival(true); setTab("log"); }} />}
    {tab === "log" && <TrainingLog data={data} historyVersion={tracker.dataUpdatedAt} onSaved={refresh} openOnArrival={openLogOnArrival} />}
    {tab === "plan" && <TrainingPlan data={data} onSaved={refresh} onCheck={(key, checked) => check.mutate({ group: "milestone", key, checked })} />}
    {tab === "bow" && <BowAndGear data={data} onSaved={refresh} />}
    {tab === "nutrition" && <Nutrition recipes={data.recipes} />}
    {tab === "settings" && <SettingsTab me={me} />}
    {cycleHistoryOpen && <CycleHistoryModal summaries={data.cycleSummaries.filter((summary) => summary.cycle < data.state.currentCycle)} onClose={() => setCycleHistoryOpen(false)} />}
  </ShellFrame>;
}
