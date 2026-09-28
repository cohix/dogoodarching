import { type Recipe } from "../../api";
import { useState } from "react";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { Empty } from "../../components/Empty";

export function Nutrition({ recipes }: { recipes: Recipe[] }) {
  const [selected, setSelected] = useState<Recipe | null>(null);
  useEscapeToClose(() => { if (selected) setSelected(null); });

  const recipeDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

  return <div className="space-y-3">
    <p className="text-sm leading-6 text-[var(--dim)]">Meals from your daily check-ins, newest first.</p>
    {recipes.length === 0 ? <Empty>Your first daily check-in meal will appear here.</Empty> : recipes.map((recipe) => <article key={recipe.id} className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--dim)]">{recipeDate(recipe.updatedAt)}</p>
          <h2 className="mt-1 text-lg font-bold leading-6">{recipe.name}</h2>
        </div>
        <button type="button" onClick={() => setSelected(recipe)} className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`View full recipe for ${recipe.name}`}>Details</button>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-[var(--dim)]">{recipe.summary}</p>
    </article>)}

    {selected && <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="recipe-title" onClick={() => setSelected(null)}>
      <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-[var(--dim)]">Daily check-in · {recipeDate(selected.updatedAt)}</p>
            <h2 id="recipe-title" className="mt-1 text-2xl font-extrabold leading-8 tracking-[-.02em]">{selected.name}</h2>
          </div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Close recipe details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button>
        </div>
        <section className="mt-5">
          <h3 className="section-title">Overview</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.summary}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Ingredients</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.ingredients}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Method</h3>
          {selected.instructions ? <p className="mt-2 whitespace-pre-line text-sm leading-6">{selected.instructions}</p> : <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Method wasn’t saved with this earlier check-in.</p>}
        </section>
        <button type="button" onClick={() => setSelected(null)} className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
      </article>
    </div>}
  </div>;
}
