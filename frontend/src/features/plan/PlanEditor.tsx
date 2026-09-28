import { type CyclePlanItem, isStarterPlan } from "./defaults";
import { type PlannedSession, type PlanDayKey, api } from "../../api";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { localDate } from "../../lib/dates";
import { PlannedSessionModal } from "./PlannedSessionModal";

export function PlanEditor({ plans, plannedSessions, state, onSaved, athleteId }: {
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
    <section><div className="mb-2"><h2 className="section-title">Weekly rhythm</h2>{isStarterPlan(plannedSessions)
      ? <p className="mt-1 text-xs leading-5 text-[var(--dim)]">{athleteId ? "This athlete still has the starter plan: a generic template. Tap a day to set their plan; they can edit it too." : "This is the starter plan: a generic template. Tap a day to make it your own; your coach can edit it too."}</p>
      : <p className="mt-1 text-xs leading-5 text-[var(--dim)]">Tap a day to edit it.</p>}</div><div className="space-y-2">{plannedSessions.map((session) => <button type="button" key={session.dayKey} onClick={() => setSelectedSessionKey(session.dayKey)} className="card flex w-full items-center gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open and edit ${session.day} ${session.sessionType} plan`}><span className="w-9 shrink-0 text-xs font-black text-[var(--accent)]">{session.short}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{session.detail}{session.updatedAt === null && <span className="ml-2 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] text-[var(--dim)]">Starter</span>}</span><span className="mt-0.5 block line-clamp-1 text-xs text-[var(--dim)]">{session.sessionType} · {session.prescription}</span></span><span aria-hidden="true" className="shrink-0 text-[var(--dim)]">→</span></button>)}</div></section>
    {selectedSession && <PlannedSessionModal key={selectedSession.dayKey} session={selectedSession} onClose={() => setSelectedSessionKey(null)} onSaved={onSaved} athleteId={athleteId} />}
  </div>;
}
