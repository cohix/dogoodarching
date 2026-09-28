import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { localDate } from "../../lib/dates";
import { api } from "../../api";

/**
 * Shown on the dashboard while `state.currentPoundage` is null (a new athlete,
 * or an account whose program state was never set). Saving writes
 * `program_state.current_poundage`; the tracker query is then refetched by
 * `onSaved`, which reveals the poundage-dependent content.
 */
export function PoundagePrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: (poundage: number) => api.savePoundage({ poundage, today: localDate() }),
    onSuccess: () => { setError(""); onSaved(); },
    onError: () => setError("Couldn’t save your poundage. Try again."),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const poundage = Number(value);
    if (!Number.isInteger(poundage) || poundage < 1 || poundage > 100) { setError("Enter a whole number between 1 and 100."); return; }
    save.mutate(poundage);
  };
  return <section className="card p-4" aria-labelledby="poundage-prompt-title">
    <h2 id="poundage-prompt-title" className="section-title">Set your bow poundage</h2>
    <p className="mt-1 text-sm leading-6 text-[var(--dim)]">Your draw weight isn’t set yet. Add it to see poundage milestones and match your gear setups.</p>
    <form onSubmit={submit} className="mt-3 flex items-end gap-2">
      <label className="min-w-0 flex-1"><span className="label">Poundage (lb)</span><input className="field" aria-label="Current bow poundage in pounds" type="number" inputMode="numeric" min={1} max={100} step={1} value={value} onChange={(event) => setValue(event.target.value)} placeholder="e.g. 24" required /></label>
      <button type="submit" disabled={save.isPending || !value} className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{save.isPending ? "Saving…" : "Save"}</button>
    </form>
    {error && <p role="alert" className="mt-2 text-xs font-semibold text-[var(--accent)]">{error}</p>}
  </section>;
}
