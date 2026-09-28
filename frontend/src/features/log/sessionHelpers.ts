import { type HistoricalWeeklyNote, type PlannedSession, type SessionType, type TrainingSession, type PracticeScore } from "../../api";
import { formatDate } from "../../lib/dates";
import { formatAverage } from "../../lib/format";

type WeeklyNote = HistoricalWeeklyNote;

export const sessionTypes: SessionType[] = ["Range", "Gym", "SPT", "Class", "Other"];

/**
 * Default log type for `date`: the planned session type for that weekday when it
 * matches one of the log's fixed types (case-insensitive); planned types are free
 * text ("Practice", "Rest", …), so anything else falls back to "Range".
 */
export function prescribedType(date: string, plannedSessions: PlannedSession[]): SessionType {
  const weekday = (new Date(`${date}T12:00:00`).getDay() + 6) % 7; // 0 = Monday
  const planned = plannedSessions[weekday]?.sessionType.trim().toLowerCase();
  return sessionTypes.find((type) => type.toLowerCase() === planned) ?? "Range";
}

export function sessionLabel(session: Pick<TrainingSession, "sessionType" | "customActivity">) {
  return session.sessionType === "Other" && session.customActivity.trim() ? session.customActivity : session.sessionType;
}

export function sessionShareText(session: TrainingSession) {
  return [
    `Do Good Arching — ${sessionLabel(session)} session`,
    `Date: ${formatDate(session.sessionDate)}`,
    session.durationMinutes ? `Duration: ${session.durationMinutes} min` : "",
    session.arrows ? `Arrows: ${session.arrows}` : "",
    session.focus ? `Focus: ${session.focus}` : "",
    session.score ? `Score: ${session.score}` : "",
    session.notes ? `Notes: ${session.notes}` : "",
  ].filter(Boolean).join("\n");
}

export function practiceScoreShareText(score: PracticeScore) {
  const ends = score.ends.map((end) => `End ${end.endNumber}: ${end.arrows.join(", ")} — ${end.total} (avg ${formatAverage(end.averageArrow)})`).join("\n");
  return [
    "Do Good Arching — Practice score",
    `Date: ${formatDate(score.scoreDate)}`,
    `Total: ${score.total}/300`,
    `Average arrow: ${formatAverage(score.averageArrow)}`,
    `Average end: ${formatAverage(score.averageEnd)}`,
    "",
    ends,
  ].join("\n");
}

export function weeklyNoteShareText(note: WeeklyNote) {
  return ["Do Good Arching — Weekly notes", `Week of ${formatDate(note.weekStart)}`, "", note.notes].join("\n");
}
