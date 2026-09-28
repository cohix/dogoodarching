import { type TrainingSession, api, type SessionType } from "../../api";
import { useState, type FormEvent } from "react";
import { useEscapeToClose } from "../../components/useEscapeToClose";

export function EditSessionModal({ session, onClose, onSave, saving, error }: { session: TrainingSession; onClose: () => void; onSave: (values: Parameters<typeof api.updateSession>[0]) => void; saving: boolean; error: string }) {
  const [draft, setDraft] = useState({
    sessionDate: session.sessionDate,
    sessionType: session.sessionType,
    customActivity: session.customActivity,
    arrows: session.arrows,
    durationMinutes: session.durationMinutes,
    focus: session.focus,
    score: session.score,
    notes: session.notes,
  });
  useEscapeToClose(onClose);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ id: session.id, ...draft, customActivity: draft.sessionType === "Other" ? draft.customActivity : "" });
  };
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="edit-session-title" onClick={onClose}>
    <form onSubmit={submit} className="max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:p-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">Training history</p><h2 id="edit-session-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Edit session</h2></div><button type="button" onClick={onClose} aria-label="Close session editor" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <label><span className="label">Date</span><input className="field" aria-label="Edit session date" type="date" value={draft.sessionDate} onChange={(event) => setDraft({ ...draft, sessionDate: event.target.value })} required /></label>
        <label><span className="label">Session</span><select className="field" aria-label="Edit session type" value={draft.sessionType} onChange={(event) => setDraft({ ...draft, sessionType: event.target.value as SessionType })}>{["Range", "Gym", "SPT", "Class", "Other"].map((value) => <option key={value}>{value}</option>)}</select></label>
        {draft.sessionType === "Other" && <label className="col-span-2"><span className="label">Activity name</span><input className="field" aria-label="Edit activity name" value={draft.customActivity} maxLength={80} onChange={(event) => setDraft({ ...draft, customActivity: event.target.value })} required /></label>}
        <label><span className="label">Arrows</span><input className="field" aria-label="Edit arrows shot" type="number" min="0" max="1000" inputMode="numeric" value={draft.arrows} onChange={(event) => setDraft({ ...draft, arrows: Number(event.target.value) })} /></label>
        <label><span className="label">Duration</span><input className="field" aria-label="Edit duration in minutes" type="number" min="0" max="1440" inputMode="numeric" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label>
      </div>
      <label className="mt-3 block"><span className="label">Focus</span><input className="field" aria-label="Edit training focus" value={draft.focus} maxLength={200} onChange={(event) => setDraft({ ...draft, focus: event.target.value })} /></label>
      <label className="mt-3 block"><span className="label">Score</span><input className="field" aria-label="Edit score" value={draft.score} maxLength={100} placeholder="Optional, e.g. 278/300" onChange={(event) => setDraft({ ...draft, score: event.target.value })} /></label>
      <label className="mt-3 block"><span className="label">Notes</span><textarea className="field min-h-24 resize-y" aria-label="Edit session notes" value={draft.notes} maxLength={3000} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
      {error && <p role="alert" className="mt-3 text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
      <div className="sticky bottom-0 -mx-4 mt-5 flex gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-3 sm:-mx-5 sm:px-5"><button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={saving} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button></div>
    </form>
  </div>;
}
