import { type Tracker } from "../../lib/types";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
import { localDate, formatDate } from "../../lib/dates";

export function WeeklyNotesCard({ note, onSaved }: { note: Tracker["currentWeeklyNote"]; onSaved: () => void }) {
  const [text, setText] = useState(note.notes);
  const [status, setStatus] = useState("");
  useEffect(() => {
    setText(note.notes);
    setStatus("");
  }, [note.weekStart]);
  const save = useMutation({
    mutationFn: () => api.saveWeeklyNote({ today: localDate(), notes: text }),
    onSuccess: () => { onSaved(); setStatus("Saved"); },
    onError: () => setStatus("Couldn’t save. Try again."),
  });
  const dirty = text !== note.notes;
  return <section className="card p-4" aria-labelledby="weekly-notes-heading">
    <div className="flex items-start justify-between gap-3"><div><h2 id="weekly-notes-heading" className="section-title">Weekly notes</h2><p className="mt-1 text-xs text-[var(--dim)]">Week of {formatDate(note.weekStart)}</p></div><div className="flex min-h-8 items-center gap-2">{status && <span role="status" className="text-xs font-semibold text-[var(--dim)]">{status}</span>}<button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{save.isPending ? "Saving…" : "Save"}</button></div></div>
    <textarea className="field mt-3 min-h-32 resize-y leading-6" aria-label="Notes for this week" value={text} maxLength={8000} onChange={(event) => { setText(event.target.value); setStatus(""); }} placeholder="What changed this week? What felt strong? What should carry forward?" />
    <p className="mt-2 text-xs leading-5 text-[var(--dim)]">At the start of next week, these notes move into History and a fresh page opens here.</p>
  </section>;
}
