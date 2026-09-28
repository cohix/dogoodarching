import { type CycleSummary } from "../../api";
import { formatAverage } from "../../lib/format";
import { statusColor } from "./trainingStatus";
import { type Tracker } from "../../lib/types";
import { useEscapeToClose } from "../../components/useEscapeToClose";

export function CycleSummaryCard({ summary }: { summary: CycleSummary }) {
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

export function CycleHistoryModal({ summaries, onClose }: { summaries: Tracker["cycleSummaries"]; onClose: () => void }) {
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
