export type TrainingDayStatus = "completed" | "skipped" | "upcoming";

export const statusColor: Record<TrainingDayStatus, string> = { completed: "var(--status-completed)", skipped: "var(--status-skipped)", upcoming: "var(--status-upcoming)" };
