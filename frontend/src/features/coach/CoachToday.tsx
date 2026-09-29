import { useQuery } from "@tanstack/react-query";
import { api, type CoachTeamAthlete } from "../../api";
import { Empty } from "../../components/Empty";
import { localDate } from "../../lib/dates";
import { formatAverage } from "../../lib/format";
import { CycleWeeksGrid } from "../dashboard/CycleWeeksGrid";

/** Query key prefix for `api.coachOverview`; invalidate it with `coach-overview`. */
export const coachTeamOverviewKey = "coach-team-overview";

/** Coach Today: every active athlete's current cycle, arrows and averages. */
export function CoachToday({ onOpenAthlete }: { onOpenAthlete: (athleteId: string) => void }) {
  const today = localDate();
  const overview = useQuery({ queryKey: [coachTeamOverviewKey, today], queryFn: () => api.coachOverview(today) });
  if (overview.isPending) return <Empty>Loading athletes…</Empty>;
  if (overview.error) return <div className="card p-4"><p className="text-sm text-[var(--text)]">Athletes couldn’t be loaded.</p><button type="button" onClick={() => overview.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>;
  const athletes = overview.data.athletes;
  return <div className="space-y-3">
    <p className="text-sm leading-6 text-[var(--dim)]">Where each active athlete is in their current cycle. Tap an athlete to open their plan.</p>
    {athletes.length === 0
      ? <Empty>No active athletes yet. Go to Team to invite your first athlete.</Empty>
      : athletes.map((athlete) => <AthleteCard key={athlete.id} athlete={athlete} onOpen={() => onOpenAthlete(athlete.id)} />)}
  </div>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div><p className="text-xl font-extrabold">{value}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">{label}</p></div>;
}

function AthleteCard({ athlete, onOpen }: { athlete: CoachTeamAthlete; onOpen: () => void }) {
  const name = athlete.displayName || athlete.username;
  const perSession = athlete.averagePerSession === null ? "—" : formatAverage(athlete.averagePerSession);
  return <button type="button" onClick={onOpen} className="card block w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${name}’s training overview. Cycle ${athlete.currentCycle}, Week ${athlete.currentWeek}. ${athlete.cycleArrows} cycle arrows, ${formatAverage(athlete.averagePerWeek)} average per week, ${perSession === "—" ? "no sessions logged" : `${perSession} average per session`} this cycle.`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-lg font-bold">{name}</p>
        <p className="mt-0.5 text-xs font-bold uppercase tracking-[.1em] text-[var(--accent)]">Cycle {athlete.currentCycle}, Week {athlete.currentWeek}</p>
      </div>
      <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-bold">{athlete.currentPoundage === null ? "Poundage not set" : `${athlete.currentPoundage} lb`}</span>
    </div>
    <CycleWeeksGrid weeks={athlete.currentCycleSummary.weeks} currentWeek={athlete.currentWeek} className="mt-4" label={`Cycle ${athlete.currentCycle} progress. ${athlete.currentCycleSummary.weeks.map((week) => `Week ${week.weekNumber}: ${week.arrows} arrows`).join(", ")}`} />
    <div className="mt-4 grid grid-cols-3 divide-x divide-[var(--border)] border-t border-[var(--border)] pt-3 text-center">
      <Stat value={String(athlete.cycleArrows)} label="Cycle arrows" />
      <Stat value={formatAverage(athlete.averagePerWeek)} label="Average / week" />
      <Stat value={perSession} label="Average / session" />
    </div>
    <span className="mt-3 block text-xs font-bold text-[var(--accent)]">View overview <span aria-hidden="true">→</span></span>
  </button>;
}
