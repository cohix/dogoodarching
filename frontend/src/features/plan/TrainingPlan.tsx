import { type Tracker } from "../../lib/types";
import { PlanEditor } from "./PlanEditor";
import { cyclePlanFor, plannedSessionsFor, milestones } from "./defaults";
import { CheckRow } from "../../components/CheckRow";

export function TrainingPlan({ data, onSaved, onCheck }: { data: Tracker; onSaved: () => void; onCheck: (key: string, checked: boolean) => void }) {
  return <div className="space-y-6">
    <PlanEditor plans={cyclePlanFor(data)} plannedSessions={plannedSessionsFor(data)} state={data.state} onSaved={onSaved} />
    <section><h2 className="section-title mb-2">Poundage milestones</h2><div className="space-y-3">{milestones.map((m) => <div key={m.weight} className="card p-4"><div className="flex items-baseline justify-between gap-3"><p className="text-xl font-extrabold">{m.weight} lb</p><p className="text-xs font-bold text-[var(--accent)]">{m.target}</p></div><p className="mt-1 text-sm text-[var(--dim)]">{m.note}</p><div className="mt-3 divide-y divide-[var(--border)]">{m.tasks.map((task) => { const key = `${m.weight}:${task}`; return <CheckRow key={key} label={task} checked={data.milestoneChecks[key] ?? false} onChange={(v) => onCheck(key, v)} />; })}</div></div>)}</div></section>
    <aside className="rounded-xl bg-[var(--accent-soft)] p-4 text-sm leading-6"><strong>Load rule:</strong> Deload every fourth week—halve volume and keep form work. A bare-shaft tune is mandatory at every 4 lb increase.</aside>
  </div>;
}
