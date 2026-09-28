import { type Tracker } from "../../lib/types";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, Bar } from "recharts";

export function ArrowHistoryModal({ weeklyArrows, onClose }: { weeklyArrows: Tracker["weeklyArrows"]; onClose: () => void }) {
  useEscapeToClose(onClose);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="arrow-history-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Last 8 logged weeks</p><h2 id="arrow-history-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Arrows by week</h2></div><button type="button" onClick={onClose} aria-label="Close arrows by week chart" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      {weeklyArrows.length === 0 ? <p className="py-12 text-center text-sm text-[var(--dim)]">The chart starts with your first range log.</p> : <div className="mt-5 h-56 w-full" aria-label="Weekly arrows bar chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={weeklyArrows} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}><CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="week" tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }} /><Bar dataKey="arrows" name="Arrows" fill="var(--accent)" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}
