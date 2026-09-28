import { type PracticeScore } from "../../api";
import { formatDate, localDate } from "../../lib/dates";
import { formatAverage } from "../../lib/format";
import { ShareButton } from "../../components/ShareButton";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { useState, type FormEvent } from "react";

type ScoreDraft = (number | null)[][];

const emptyScoreDraft = (): ScoreDraft => Array.from({ length: 10 }, () => [null, null, null]);

export function PracticeScoreEntry({ score, onOpen, onShare }: { score: PracticeScore; onOpen: () => void; onShare: () => void }) {
  return <article className="card p-4">
    <button type="button" onClick={onOpen} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open practice score from ${formatDate(score.scoreDate)}, ${score.total} out of 300`}>
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-bold">Practice score · {formatDate(score.scoreDate)}</p><p className="mt-1 text-xs text-[var(--dim)]">10 ends · 30 arrows</p></div>
        <div className="text-right"><p className="text-xl font-extrabold text-[var(--accent)]">{score.total}<span className="text-xs font-bold text-[var(--dim)]"> / 300</span></p><p className="mt-0.5 text-[11px] font-semibold text-[var(--dim)]">View details →</p></div>
      </div>
    </button>
    <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t border-[var(--border)] pt-3">
      <div><p className="text-[11px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Avg arrow</p><p className="mt-0.5 text-sm font-extrabold">{formatAverage(score.averageArrow)}</p></div>
      <div><p className="text-[11px] font-bold uppercase tracking-[.06em] text-[var(--dim)]">Avg end</p><p className="mt-0.5 text-sm font-extrabold">{formatAverage(score.averageEnd)}</p></div>
      <ShareButton label={`Share practice score from ${formatDate(score.scoreDate)}`} onClick={onShare} />
    </div>
  </article>;
}

export function PracticeScoreModal({ score, onClose, onDelete, deleting }: { score: PracticeScore; onClose: () => void; onDelete: () => void; deleting: boolean }) {
  useEscapeToClose(onClose);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="practice-score-details-title" onClick={onClose}>
    <article className="score-modal-scroll max-h-[92dvh] min-w-0 w-full max-w-full overflow-x-hidden overflow-y-auto overscroll-x-none rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:px-5 sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">{formatDate(score.scoreDate)} · 30 arrows</p><h2 id="practice-score-details-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Practice score</h2></div><button type="button" onClick={onClose} aria-label="Close practice score details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <div className="mt-5 grid grid-cols-3 divide-x divide-[var(--border)] rounded-xl bg-[var(--surface-2)] py-3 text-center"><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Total</p><p className="mt-1 text-lg font-extrabold">{score.total}/300</p></div><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Avg arrow</p><p className="mt-1 text-lg font-extrabold">{formatAverage(score.averageArrow)}</p></div><div><p className="text-[10px] font-bold uppercase text-[var(--dim)]">Avg end</p><p className="mt-1 text-lg font-extrabold">{formatAverage(score.averageEnd)}</p></div></div>
      <div className="mt-5 min-w-0">
        <div className="score-grid px-2 pb-2 text-[10px] font-bold uppercase tracking-[.04em] text-[var(--dim)]"><span>End</span><span>A1</span><span>A2</span><span>A3</span><span>Total</span><span>Avg</span></div>
        <div className="divide-y divide-[var(--border)]">{score.ends.map((end) => <div key={end.endNumber} className="score-grid px-2 py-2.5 text-center text-sm"><strong>{end.endNumber}</strong>{end.arrows.map((arrow, index) => <span key={index}>{arrow}</span>)}<strong>{end.total}</strong><span className="text-[var(--dim)]">{formatAverage(end.averageArrow)}</span></div>)}</div>
      </div>
      <div className="mt-5 flex gap-2"><button type="button" disabled={deleting} onClick={onDelete} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--dim)] disabled:opacity-50">{deleting ? "Deleting…" : "Delete"}</button><button type="button" onClick={onClose} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button></div>
    </article>
  </div>;
}

export function ScoreEntryModal({ onClose, onSave, saving, error }: { onClose: () => void; onSave: (date: string, ends: [number, number, number][]) => void; saving: boolean; error: string }) {
  const [date, setDate] = useState(localDate());
  const [ends, setEnds] = useState<ScoreDraft>(emptyScoreDraft);
  useEscapeToClose(onClose);
  const values = ends.flat();
  const entered = values.filter((value): value is number => value !== null);
  const total = entered.reduce((sum, value) => sum + value, 0);
  const complete = entered.length === 30;
  const updateArrow = (endIndex: number, arrowIndex: number, raw: string) => {
    const parsed = raw === "" ? null : Math.max(0, Math.min(10, Number(raw)));
    setEnds((current) => current.map((end, index) => index === endIndex ? end.map((value, indexWithinEnd) => indexWithinEnd === arrowIndex ? parsed : value) : end));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete) return;
    onSave(date, ends.map((end) => [end[0] ?? 0, end[1] ?? 0, end[2] ?? 0]));
  };
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="practice-score-title" onClick={onClose}>
    <form onSubmit={submit} className="score-modal-scroll max-h-[94dvh] min-w-0 w-full max-w-full overflow-x-hidden overflow-y-auto overscroll-x-none rounded-t-[20px] bg-[var(--surface)] px-4 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:px-5 sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[var(--dim)]">10 ends · 3 arrows each</p><h2 id="practice-score-title" className="mt-1 text-2xl font-extrabold tracking-[-.02em]">Record practice score</h2></div><button type="button" onClick={onClose} aria-label="Close score entry" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button></div>
      <label className="mt-4 block"><span className="label">Date</span><input className="field" aria-label="Practice score date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
      <div className="mt-4 rounded-xl bg-[#17372a] px-4 py-3 text-white"><div className="grid grid-cols-3 divide-x divide-white/15 text-center"><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Total</p><p className="mt-1 text-xl font-extrabold">{total}<span className="text-xs text-[#a9d2bb]"> / 300</span></p></div><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Avg arrow</p><p className="mt-1 text-xl font-extrabold">{entered.length ? formatAverage(total / entered.length) : "—"}</p></div><div><p className="text-[10px] font-bold uppercase text-[#a9d2bb]">Entered</p><p className="mt-1 text-xl font-extrabold">{entered.length}<span className="text-xs text-[#a9d2bb]"> / 30</span></p></div></div></div>
      <div className="mt-5"><div className="score-entry-grid px-1 pb-2 text-center text-[10px] font-bold uppercase tracking-[.04em] text-[var(--dim)]"><span>End</span><span>Arrow 1</span><span>Arrow 2</span><span>Arrow 3</span><span>Total</span><span>Avg</span></div><div className="divide-y divide-[var(--border)]">{ends.map((end, endIndex) => {
        const filled = end.filter((value): value is number => value !== null);
        const endTotal = filled.reduce((sum, value) => sum + value, 0);
        return <div key={endIndex} className="score-entry-grid items-center px-1 py-2"><strong className="text-center text-sm">{endIndex + 1}</strong>{end.map((value, arrowIndex) => <input key={arrowIndex} className="score-arrow" aria-label={`End ${endIndex + 1}, arrow ${arrowIndex + 1}`} type="number" min="0" max="10" inputMode="numeric" value={value ?? ""} onChange={(event) => updateArrow(endIndex, arrowIndex, event.target.value)} />)}<strong className="text-center text-sm">{filled.length ? endTotal : "—"}</strong><span className="text-center text-xs text-[var(--dim)]">{filled.length ? formatAverage(endTotal / filled.length) : "—"}</span></div>;
      })}</div></div>
      {!complete && <p className="mt-3 text-center text-xs text-[var(--dim)]">Enter all 30 arrow values to save.</p>}{error && <p role="alert" className="mt-3 text-center text-xs font-semibold text-[var(--accent)]">{error}</p>}
      <div className="sticky bottom-0 -mx-4 mt-4 flex gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-3 pt-3 sm:-mx-5 sm:px-5"><button type="button" onClick={onClose} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button><button type="submit" disabled={!complete || saving} className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-45">{saving ? "Saving…" : `Save ${total}/300`}</button></div>
    </form>
  </div>;
}
