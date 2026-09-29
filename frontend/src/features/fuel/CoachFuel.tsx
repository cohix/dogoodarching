import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type TeamMeal, type TeamMealInput } from "../../api";
import { Empty } from "../../components/Empty";
import { notFoundAware } from "../../lib/mutations";
import { MealCard, MealDetailsModal, type MealItem } from "./Nutrition";

export const teamMealsKey = ["coach-meals"] as const;

const blankMeal: TeamMealInput = { name: "", summary: "", ingredients: "", instructions: "" };
// Mirrors the server's shared recipe field limits.
const fields: { key: keyof TeamMealInput; label: string; maxLength: number; multiline: boolean }[] = [
  { key: "name", label: "Meal name", maxLength: 200, multiline: false },
  { key: "summary", label: "Summary", maxLength: 1500, multiline: true },
  { key: "ingredients", label: "Ingredients", maxLength: 3000, multiline: true },
  { key: "instructions", label: "Method", maxLength: 6000, multiline: true },
];

const teamMeal = (meal: TeamMeal): MealItem => ({
  key: `team:${meal.id}`, name: meal.name, summary: meal.summary, ingredients: meal.ingredients, instructions: meal.instructions,
  date: meal.createdAt, origin: `Team meal · ${meal.author}`,
});

/** Coach Fuel: team meals shown in every active athlete's Fuel feed. Any coach may edit or delete any meal. */
export function CoachFuel() {
  const qc = useQueryClient();
  const meals = useQuery({ queryKey: teamMealsKey, queryFn: () => api.listTeamMeals() });
  const [draft, setDraft] = useState<TeamMealInput>(blankMeal);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: teamMealsKey });
  const resetForm = () => { setDraft(blankMeal); setEditingId(null); };
  const failure = (fallback: string) => (err: unknown) => setError(err instanceof ApiError && err.status !== 0 && err.status < 500 ? err.message : fallback);
  const save = useMutation({
    mutationFn: (args: { id: number | null; meal: TeamMealInput }) => args.id === null ? api.addTeamMeal(args.meal) : api.updateTeamMeal({ id: args.id, ...args.meal }),
    onMutate: () => { setMessage(""); setError(""); },
    onSuccess: async (_result, args) => {
      resetForm();
      setMessage(args.id === null ? "Meal added. Athletes will see it in Fuel." : "Meal updated.");
      await refresh();
    },
    // 404: another coach deleted it while it was being edited.
    onError: notFoundAware(() => { resetForm(); setMessage("That meal was already deleted."); void refresh(); }, failure("Couldn’t save this meal. Try again.")),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteTeamMeal({ id }),
    onMutate: () => { setMessage(""); setError(""); },
    onSuccess: async (_result, id) => {
      if (editingId === id) resetForm();
      setMessage("Meal deleted.");
      await refresh();
    },
    onError: notFoundAware(() => { void refresh(); }, failure("Couldn’t delete this meal. Try again.")),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const meal = { name: draft.name.trim(), summary: draft.summary.trim(), ingredients: draft.ingredients.trim(), instructions: draft.instructions.trim() };
    if (Object.values(meal).some((value) => !value)) { setError("Fill in every field."); return; }
    save.mutate({ id: editingId, meal });
  };
  const startEdit = (meal: TeamMeal) => {
    setEditingId(meal.id);
    setDraft({ name: meal.name, summary: meal.summary, ingredients: meal.ingredients, instructions: meal.instructions });
    setMessage(""); setError("");
    formRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const items = (meals.data?.meals ?? []).map(teamMeal);
  return <div className="space-y-5">
    <p className="text-sm leading-6 text-[var(--dim)]">Meals you add here appear in every active athlete’s Fuel feed, alongside their own check-in meals. Any coach can edit or delete them.</p>
    <form ref={formRef} onSubmit={submit} className="card space-y-3 p-4" aria-labelledby="meal-form-heading">
      <h2 id="meal-form-heading" className="section-title">{editingId === null ? "Add meal" : "Edit meal"}</h2>
      <fieldset disabled={save.isPending} className="min-w-0 space-y-3">
        {fields.map((field) => <label key={field.key} className="block"><span className="label">{field.label}</span>{field.multiline
          ? <textarea className="field min-h-20 resize-y leading-6" required maxLength={field.maxLength} value={draft[field.key]} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
          : <input className="field" required maxLength={field.maxLength} value={draft[field.key]} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />}</label>)}
        <div className="flex gap-2">
          {editingId !== null && <button type="button" onClick={() => { resetForm(); setError(""); }} className="flex-1 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold">Cancel</button>}
          <button type="submit" className="flex-[2] rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{save.isPending ? "Saving…" : editingId === null ? "Add meal" : "Save changes"}</button>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-xs font-semibold text-[var(--accent)]">{error}</p>}
      {message && <p role="status" className="text-xs font-semibold text-[var(--dim)]">{message}</p>}
    </form>
    <section className="space-y-3" aria-labelledby="team-meals-heading">
      <h2 id="team-meals-heading" className="section-title">Team meals</h2>
      {meals.isPending ? <Empty>Loading team meals…</Empty>
        : meals.error ? <div className="card p-4"><p className="text-sm text-[var(--text)]">Team meals couldn’t be loaded.</p><button type="button" onClick={() => meals.refetch()} className="mt-3 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white">Try again</button></div>
        : meals.data.meals.length === 0 ? <Empty>No team meals yet. Add the first one above.</Empty>
        : meals.data.meals.map((meal) => <MealCard key={meal.id} meal={teamMeal(meal)} onOpen={() => setSelectedKey(`team:${meal.id}`)} actions={<div className="mt-3 flex gap-2 border-t border-[var(--border)] pt-3">
          <button type="button" onClick={() => startEdit(meal)} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs font-bold" aria-label={`Edit ${meal.name}`}>Edit</button>
          <button type="button" disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete “${meal.name}”? It will be removed from every athlete’s Fuel feed.`)) remove.mutate(meal.id); }} className="rounded-lg px-3 py-2 text-xs font-bold text-[var(--accent)] disabled:opacity-50" aria-label={`Delete ${meal.name}`}>{remove.isPending && remove.variables === meal.id ? "Deleting…" : "Delete"}</button>
          <span className="ml-auto self-center truncate text-[11px] text-[var(--dim)]">by {meal.author}</span>
        </div>} />)}
    </section>
    {selectedKey && <MealDetailsModal meals={items} mealKey={selectedKey} onClose={() => setSelectedKey(null)} />}
  </div>;
}
