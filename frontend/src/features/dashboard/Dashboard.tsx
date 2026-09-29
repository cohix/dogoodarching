import { type TrainingDayStatus, statusColor } from "./trainingStatus";
import { type Tracker } from "../../lib/types";
import { useState } from "react";
import { type PlanDayKey } from "../../api";
import { localDate, mondayOf, dateKey, addDays, formatDate } from "../../lib/dates";
import { plannedSessionsFor, cyclePlanFor, milestones } from "../plan/defaults";
import { formatAverage } from "../../lib/format";
import { Empty } from "../../components/Empty";
import { sessionLabel } from "../log/sessionHelpers";
import { Inspiration } from "./Inspiration";
import { PlannedSessionModal } from "../plan/PlannedSessionModal";
import { PoundagePrompt } from "./PoundagePrompt";
import { CycleWeeksGrid } from "./CycleWeeksGrid";

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

export function Dashboard({ data, onLog, onSaved }: { data: Tracker; onLog: () => void; onSaved: () => void }) {
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
  // Poundage-dependent content is hidden behind the prompt until the athlete sets it.
  const poundage = data.state.currentPoundage;
  const next = poundage === null ? null : (milestones.find((m) => m.weight > poundage) ?? milestones[milestones.length - 1]!);
  const weekArrows = data.weeklyArrows.at(-1)?.arrows ?? 0;
  return <div className="space-y-5">
    <section className="overflow-hidden rounded-[18px] bg-[#17372a] p-5 text-white shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 pt-1"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#a9d2bb]">Cycle {data.state.currentCycle}, Week {data.state.currentWeek}</p><p className="mt-2 text-3xl font-extrabold tracking-tight">{focus}</p><p className="mt-1 text-sm text-[#c7dbcf]">Primary technical focus</p></div>
        <WeeklySessionRing days={currentWeekDays} onLog={onLog} completedToday={sessionDates.has(todayKey)} />
      </div>
      <div className="mt-5 border-t border-white/15 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3"><p className="text-xs font-bold text-white">Current cycle</p><p className="text-[10px] font-semibold text-[#a9d2bb]">6 weeks · 36 training days</p></div>
        <CycleWeeksGrid weeks={cycleWeeks} currentWeek={data.state.currentWeek} tone="hero" label={`Six-week cycle progress. ${cycleWeeks.flatMap((week) => week.dayStatuses).filter((status) => status === "completed").length} completed, ${cycleWeeks.flatMap((week) => week.dayStatuses).filter((status) => status === "skipped").length} skipped. ${cycleWeeks.map((week) => `Week ${week.weekNumber}: ${week.arrows} arrows`).join(", ")}.`} />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-semibold text-[#c7dbcf]">{(["completed", "skipped", "upcoming"] as TrainingDayStatus[]).map((status) => <span key={status} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusColor[status] }} />{status[0]?.toUpperCase()}{status.slice(1)}</span>)}</div>
        <div className="mt-4 grid grid-cols-2 divide-x divide-white/15 border-t border-white/15 pt-3 text-center"><div><p className="text-xl font-extrabold">{cycleTotal}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[#a9d2bb]">Cycle arrows</p></div><div><p className="text-xl font-extrabold">{formatAverage(cycleAverage)}</p><p className="text-[10px] font-bold uppercase tracking-[.06em] text-[#a9d2bb]">Average / week</p></div></div>
      </div>
    </section>
    {poundage === null && <PoundagePrompt onSaved={onSaved} />}
    <section><div className="mb-2 flex items-center justify-between"><h2 className="section-title">Today · {today.day}</h2><button type="button" onClick={onLog} className="text-sm font-bold text-[var(--accent)]">Log session</button></div><button type="button" onClick={() => setSelectedSessionKey(today.dayKey)} className="card block w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open and edit today’s ${today.sessionType} session`}><div className="flex items-start justify-between gap-3"><div><p className="text-lg font-bold">{today.sessionType}</p><p className="text-sm text-[var(--dim)]">{today.detail}</p></div><span className="rounded-full bg-[var(--green-soft)] px-2.5 py-1 text-xs font-bold text-[var(--green)]">Scheduled</span></div><p className="mt-3 border-t border-[var(--border)] pt-3 text-sm leading-6">{today.prescription}</p><p className="mt-3 text-xs font-bold text-[var(--accent)]">View details & attachments <span aria-hidden="true">→</span></p></button></section>
    <div className="grid grid-cols-2 gap-3"><div className="card p-4"><p className="text-2xl font-extrabold">{weekArrows}</p><p className="text-xs text-[var(--dim)]">arrows this logged week</p></div><div className="card p-4"><p className="text-2xl font-extrabold">{data.sessions.length}</p><p className="text-xs text-[var(--dim)]">sessions recorded</p></div></div>
    {next && <section><h2 className="section-title mb-2">Next milestone</h2><div className="card p-4"><div className="flex items-baseline justify-between"><p className="text-lg font-bold">{next.weight} lb</p><p className="text-xs font-semibold text-[var(--accent)]">{next.target}</p></div><p className="mt-1 text-sm text-[var(--dim)]">{next.note}</p></div></section>}
    <section><h2 className="section-title mb-2">Recent sessions</h2>{data.sessions.length === 0 ? <Empty>No sessions yet. Your first log will appear here.</Empty> : <div className="card divide-y divide-[var(--border)]">{data.sessions.slice(0, 4).map((s) => <div key={s.id} className="flex items-center justify-between gap-3 p-4"><div><p className="font-bold">{sessionLabel(s)} <span className="font-normal text-[var(--dim)]">· {s.focus || "General work"}</span></p><p className="mt-0.5 text-xs text-[var(--dim)]">{formatDate(s.sessionDate)} · {s.durationMinutes} min</p></div><strong className="text-sm">{s.arrows ? `${s.arrows} arr.` : "—"}</strong></div>)}</div>}</section>
    <Inspiration inspiration={data.inspiration} />
    {selectedSession && <PlannedSessionModal key={selectedSession.dayKey} session={selectedSession} onClose={() => setSelectedSessionKey(null)} onSaved={onSaved} />}
  </div>;
}
