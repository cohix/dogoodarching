import { type Tracker } from "../../lib/types";
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, Bar } from "recharts";

/**
 * Arrows-by-week bar chart, shared by the Log tab's `ArrowHistoryModal` and the
 * coach's inline athlete detail. With no logged weeks it renders `emptyText`
 * instead of a blank, zero-height chart.
 */
export function ArrowsByWeekChart({ weeklyArrows, emptyText, className = "" }: { weeklyArrows: Tracker["weeklyArrows"]; emptyText: string; className?: string }) {
  if (weeklyArrows.length === 0) return <p className={`py-12 text-center text-sm text-[var(--dim)] ${className}`}>{emptyText}</p>;
  return <div className={`h-56 w-full ${className}`} role="img" aria-label={`Weekly arrows bar chart. ${weeklyArrows.map((week) => `${week.week}: ${week.arrows} arrows`).join(", ")}`}><ResponsiveContainer width="100%" height="100%"><BarChart data={weeklyArrows} margin={{ top: 6, right: 4, bottom: 0, left: -16 }}><CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="week" tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }} /><Bar dataKey="arrows" name="Arrows" fill="var(--accent)" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>;
}
