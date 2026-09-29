import { type Tracker } from "../../lib/types";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { ArrowsByWeekChart } from "./ArrowsByWeekChart";

export function ArrowHistoryModal({ weeklyArrows, onClose, emptyText = "The chart starts with your first range log." }: { weeklyArrows: Tracker["weeklyArrows"]; onClose: () => void; emptyText?: string }) {
  useEscapeToClose(onClose);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="arrow-history-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Last 8 logged weeks</p><h2 id="arrow-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Arrows by week</h2></div><button type="button" onClick={onClose} aria-label="Close arrows by week chart" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <ArrowsByWeekChart weeklyArrows={weeklyArrows} emptyText={emptyText} className="mt-5" />
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}
