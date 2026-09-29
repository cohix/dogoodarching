import { type CycleSummaryWeek } from "../../api";
import { statusColor } from "./trainingStatus";

/**
 * The six-week cycle grid (day-status bars plus "W1 (arrows)" labels) shared by
 * the athlete Today hero, cycle summary cards and the coach Today list.
 * `tone="hero"` is for the dark Today hero; `currentWeek` highlights that label.
 */
export function CycleWeeksGrid({ weeks, label, currentWeek, tone = "card", className = "" }: {
  weeks: CycleSummaryWeek[];
  label: string;
  currentWeek?: number;
  tone?: "hero" | "card";
  className?: string;
}) {
  const labelColor = (weekNumber: number) => tone === "hero"
    ? weekNumber === currentWeek ? "text-white" : "text-[#88a093]"
    : weekNumber === currentWeek ? "text-[var(--text)]" : "text-[var(--dim)]";
  return <div role="img" aria-label={label} className={`grid grid-cols-6 gap-2 ${className}`}>
    {weeks.map((week) => <div key={week.weekNumber} className="min-w-0"><div className="flex gap-[2px]">{week.dayStatuses.map((status, dayIndex) => <span key={dayIndex} className="h-1.5 min-w-0 flex-1 rounded-full" style={{ backgroundColor: statusColor[status] }} />)}</div><p className={`mt-1.5 whitespace-nowrap text-center text-[9px] font-bold ${labelColor(week.weekNumber)}`}>W{week.weekNumber} ({week.arrows})</p></div>)}
  </div>;
}
