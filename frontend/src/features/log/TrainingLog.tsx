import { type Tracker } from "../../lib/types";
import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { localDate, formatDate } from "../../lib/dates";
import { type SessionType, type PracticeScore, type TrainingSession, api } from "../../api";
import { prescribedType, practiceScoreShareText, weeklyNoteShareText, sessionLabel, sessionShareText, sessionTypes } from "./sessionHelpers";
import { notFoundAware } from "../../lib/mutations";
import { useMutation } from "@tanstack/react-query";
import { cyclePlanFor, plannedSessionsFor } from "../plan/defaults";
import { WeeklyNotesCard } from "./WeeklyNotesCard";
import { Empty } from "../../components/Empty";
import { PracticeScoreEntry, ScoreEntryModal, PracticeScoreModal } from "./PracticeScores";
import { ShareButton } from "../../components/ShareButton";
import { PencilIcon, TrashIcon } from "../../components/icons";
import { ArrowHistoryModal } from "./ArrowHistoryModal";
import { EditSessionModal } from "./EditSessionModal";

export function TrainingLog({ data, onSaved, openOnArrival = false, historyVersion }: { data: Tracker; onSaved: () => void; openOnArrival?: boolean; historyVersion?: number }) {
  const plannedSessions = plannedSessionsFor(data);
  const [date, setDate] = useState(localDate());
  const [type, setType] = useState<SessionType>(() => prescribedType(localDate(), plannedSessions));
  const [open, setOpen] = useState(openOnArrival || data.sessions.length === 0);
  const [scoreEntryOpen, setScoreEntryOpen] = useState(false);
  const [arrowHistoryOpen, setArrowHistoryOpen] = useState(false);
  const [selectedScore, setSelectedScore] = useState<PracticeScore | null>(null);
  const [editingSession, setEditingSession] = useState<TrainingSession | null>(null);
  const [message, setMessage] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [editError, setEditError] = useState("");
  const [scoreError, setScoreError] = useState("");
  // Re-derive the default type only when the date changes, not on every plan refetch.
  useEffect(() => setType(prescribedType(date, plannedSessions)), [date]);
  const historyGeneration = useRef(0);
  const [older, setOlder] = useState<{ sessions: TrainingSession[]; next: string | null } | null>(null);
  const resetHistory = useCallback(() => {
    historyGeneration.current += 1;
    setOlder(null);
  }, []);
  // dataUpdatedAt also changes after refetches whose first page is identical.
  useEffect(resetHistory, [data, historyVersion, resetHistory]);
  const refreshHistory = () => { resetHistory(); onSaved(); };
  const add = useMutation({ mutationFn: (args: Parameters<typeof api.addSession>[0]) => api.addSession(args), onSuccess: () => { refreshHistory(); setMessage("Session saved"); setOpen(false); }, onError: () => setMessage("Couldn’t save this session. Try again.") });
  // Update/delete answer 404 when the row is already gone (deleted in another tab, or a
  // double-tapped delete). That is not an error to show: close any editor and refetch.
  const update = useMutation({
    mutationFn: (args: Parameters<typeof api.updateSession>[0]) => api.updateSession(args),
    onSuccess: () => { refreshHistory(); setEditingSession(null); setEditError(""); },
    onError: notFoundAware(() => { refreshHistory(); setEditingSession(null); setEditError(""); }, () => setEditError("Couldn’t update this session. Try again.")),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSession({ id }),
    onSuccess: () => { refreshHistory(); setHistoryMessage(""); },
    onError: notFoundAware(refreshHistory, () => setHistoryMessage("Couldn’t delete this session. Try again.")),
  });
  const addScore = useMutation({ mutationFn: (args: Parameters<typeof api.addPracticeScore>[0]) => api.addPracticeScore(args), onSuccess: () => { refreshHistory(); setScoreEntryOpen(false); setScoreError(""); }, onError: () => setScoreError("Couldn’t save this practice score. Try again.") });
  const removeScore = useMutation({
    mutationFn: (id: number) => api.deletePracticeScore({ id }),
    onSuccess: () => { refreshHistory(); setSelectedScore(null); },
    onError: notFoundAware(() => { refreshHistory(); setSelectedScore(null); }, () => setHistoryMessage("Couldn’t delete this practice score. Try again.")),
  });
  // A mutation or tracker refresh invalidates all older pages. Capture the
  // generation at request start so a response cannot restore discarded rows.
  const lastSession = data.sessions.length >= 100 ? data.sessions[data.sessions.length - 1] : undefined;
  const olderSessions = older?.sessions ?? [];
  const nextCursor = older ? older.next : lastSession ? api.sessionCursor(lastSession) : null;
  const loadOlder = useMutation({
    mutationFn: async (before: string) => {
      const generation = historyGeneration.current;
      const page = await api.getTracker({ today: localDate(), before });
      return { page, generation };
    },
    onSuccess: ({ page, generation }) => {
      if (generation !== historyGeneration.current) return;
      setOlder((previous) => {
        const base = previous?.sessions ?? [];
        const seen = new Set([...data.sessions, ...base].map((session) => session.id));
        const fresh = page.sessions.filter((session) => !seen.has(session.id));
        const last = page.sessions[page.sessions.length - 1];
        return { sessions: [...base, ...fresh], next: last && page.sessions.length >= 100 ? api.sessionCursor(last) : null };
      });
      setHistoryMessage("");
    },
    onError: () => setHistoryMessage("Couldn’t load older sessions. Try again."),
  });
  function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); add.mutate({ sessionDate: date, sessionType: type, customActivity: type === "Other" ? String(fd.get("customActivity") || "") : "", arrows: Number(fd.get("arrows") || 0), durationMinutes: Number(fd.get("duration") || 0), focus: String(fd.get("focus") || ""), score: String(fd.get("score") || ""), notes: String(fd.get("notes") || "") }); }
  const total = data.weeklyArrows.reduce((sum, w) => sum + w.arrows, 0);
  const timeline = [
    ...[...data.sessions, ...olderSessions].map((session) => ({ kind: "session" as const, date: session.sessionDate, createdAt: session.createdAt, item: session })),
    ...data.practiceScores.map((score) => ({ kind: "score" as const, date: score.scoreDate, createdAt: score.createdAt, item: score })),
    ...data.historicalWeeklyNotes.map((note) => ({ kind: "weekly-note" as const, date: note.weekStart, createdAt: note.updatedAt ?? note.weekStart, item: note })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const share = async (text: string) => {
    setHistoryMessage("");
    try {
      if (navigator.share) {
        await navigator.share({ title: "Do Good Arching", text });
        setHistoryMessage("Summary shared.");
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setHistoryMessage("Share sheet isn’t available here, so the summary was copied.");
        return;
      }
      setHistoryMessage("Sharing isn’t available in this browser.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHistoryMessage("Couldn’t share this summary. Try again.");
    }
  };
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setOpen(!open)} className="rounded-xl bg-[var(--accent)] px-3 py-3 text-sm font-extrabold text-white">{open ? "Close log" : "+ Log training"}</button><button type="button" onClick={() => { setScoreError(""); setScoreEntryOpen(true); }} className="rounded-xl bg-[#17372a] px-3 py-3 text-sm font-extrabold text-white">Score</button></div>
    {open && <form onSubmit={submit} className="card space-y-4 p-4"><div className="grid grid-cols-2 gap-3"><label><span className="label">Date</span><input className="field" aria-label="Session date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label><label><span className="label">Session</span><select className="field" aria-label="Session type" value={type} onChange={(e) => setType(e.target.value as SessionType)}>{sessionTypes.map((x) => <option key={x}>{x}</option>)}</select></label>{type === "Other" && <label className="col-span-2"><span className="label">Activity name</span><input className="field" name="customActivity" aria-label="Other activity name" maxLength={80} placeholder="e.g. Compound bow, hike, mobility" required autoFocus /></label>}<label><span className="label">Arrows</span><input className="field" name="arrows" aria-label="Arrows shot" type="number" min="0" inputMode="numeric" placeholder="0" /></label><label><span className="label">Duration</span><input className="field" name="duration" aria-label="Duration in minutes" type="number" min="0" inputMode="numeric" placeholder="Minutes" /></label></div><label><span className="label">Focus</span><input className="field" name="focus" aria-label="Training focus" defaultValue={cyclePlanFor(data).find((week) => week.weekNumber === data.state.currentWeek)?.primaryFocus ?? ""} /></label><label><span className="label">Score</span><input className="field" name="score" aria-label="Score" placeholder="Optional, e.g. 278/300" /></label><label><span className="label">Notes</span><textarea className="field min-h-20 resize-y" name="notes" aria-label="Session notes" placeholder="What clicked? What needs work?" /></label><button type="submit" disabled={add.isPending} className="w-full rounded-xl bg-[#17372a] px-4 py-3 font-bold text-white disabled:opacity-60">{add.isPending ? "Saving…" : "Save session"}</button>{message && <p role="status" className="text-center text-xs text-[var(--dim)]">{message}</p>}</form>}
    <button type="button" onClick={() => setArrowHistoryOpen(true)} className="card flex w-full items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open arrows by week chart. ${total} arrows across ${data.weeklyArrows.length} logged weeks`}><div><p className="section-title">Arrows by week</p><p className="mt-1 text-sm text-[var(--dim)]">{total} arrows across {data.weeklyArrows.length} logged {data.weeklyArrows.length === 1 ? "week" : "weeks"}</p></div><span className="shrink-0 text-sm font-bold text-[var(--accent)]">View chart →</span></button>
    <WeeklyNotesCard note={data.currentWeeklyNote} onSaved={onSaved} />
    <section><div className="mb-2 flex items-center justify-between gap-3"><h2 className="section-title">History</h2>{historyMessage && <p role="status" className="text-right text-xs font-semibold text-[var(--dim)]">{historyMessage}</p>}</div>{timeline.length === 0 ? <Empty>No training, practice scores, or weekly notes logged yet.</Empty> : <div className="space-y-2">{timeline.map((entry) => entry.kind === "score" ? <PracticeScoreEntry key={`score-${entry.item.id}`} score={entry.item} onOpen={() => setSelectedScore(entry.item)} onShare={() => void share(practiceScoreShareText(entry.item))} /> : entry.kind === "weekly-note" ? <article key={`weekly-note-${entry.item.id ?? entry.item.weekStart}`} className="card p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">Weekly notes</p><p className="mt-1 text-xs text-[var(--dim)]">Week of {formatDate(entry.item.weekStart)}</p></div><ShareButton label={`Share weekly notes from ${formatDate(entry.item.weekStart)}`} onClick={() => void share(weeklyNoteShareText(entry.item))} /></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--dim)]">{entry.item.notes}</p></article> : <article key={`session-${entry.item.id}`} className="card p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{sessionLabel(entry.item)} · {formatDate(entry.item.sessionDate)}</p><p className="mt-1 text-xs text-[var(--dim)]">{entry.item.durationMinutes} min{entry.item.arrows ? ` · ${entry.item.arrows} arrows` : ""}{entry.item.score ? ` · Score ${entry.item.score}` : ""}</p></div><div className="flex shrink-0 items-center gap-1"><ShareButton label={`Share ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} onClick={() => void share(sessionShareText(entry.item))} /><button type="button" aria-label={`Edit ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} onClick={() => { setEditError(""); setEditingSession(entry.item); }} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text)]"><PencilIcon /></button><button type="button" aria-label={`Delete ${sessionLabel(entry.item)} session from ${formatDate(entry.item.sessionDate)}`} disabled={remove.isPending} onClick={() => remove.mutate(entry.item.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--dim)] disabled:opacity-50"><TrashIcon /></button></div></div>{entry.item.focus && <p className="mt-3 text-sm"><strong>Focus:</strong> {entry.item.focus}</p>}{entry.item.notes && <p className="mt-1 text-sm text-[var(--dim)]">{entry.item.notes}</p>}</article>)}</div>}{nextCursor && <button type="button" disabled={loadOlder.isPending} onClick={() => loadOlder.mutate(nextCursor)} className="mt-3 w-full rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-bold text-[var(--dim)] disabled:opacity-50">{loadOlder.isPending ? "Loading older sessions…" : "Load older sessions"}</button>}</section>
    {arrowHistoryOpen && <ArrowHistoryModal weeklyArrows={data.weeklyArrows} onClose={() => setArrowHistoryOpen(false)} />}
    {scoreEntryOpen && <ScoreEntryModal onClose={() => setScoreEntryOpen(false)} saving={addScore.isPending} error={scoreError} onSave={(scoreDate, ends) => addScore.mutate({ scoreDate, ends })} />}
    {selectedScore && <PracticeScoreModal score={selectedScore} onClose={() => setSelectedScore(null)} deleting={removeScore.isPending} onDelete={() => removeScore.mutate(selectedScore.id)} />}
    {editingSession && <EditSessionModal key={editingSession.id} session={editingSession} onClose={() => setEditingSession(null)} onSave={(values) => update.mutate(values)} saving={update.isPending} error={editError} />}
  </div>;
}
