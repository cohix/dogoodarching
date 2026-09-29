import { type Recipe } from "../../api";
import { useState, type ReactNode } from "react";
import { useEscapeToClose } from "../../components/useEscapeToClose";
import { Empty } from "../../components/Empty";

/** A meal as shown in a Fuel feed: an athlete's check-in recipe or a team meal. */
export interface MealItem {
  key: string;
  name: string;
  summary: string;
  ingredients: string;
  instructions: string;
  date: string;
  /** Short provenance line, e.g. "Daily check-in" or "From your coach". */
  origin: string;
  /** Optional label on the card, e.g. "From your coach". */
  badge?: string;
}

export const mealDate = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

// All meal text renders as React text nodes, never as HTML.
export function MealCard({ meal, onOpen, actions }: { meal: MealItem; onOpen: () => void; actions?: ReactNode }) {
  return <article className="card p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-[var(--dim)]">{mealDate(meal.date)}{meal.badge && <span className="ml-2 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">{meal.badge}</span>}</p>
        <h2 className="mt-1 break-words text-lg font-bold leading-6">{meal.name}</h2>
      </div>
      <button type="button" onClick={onOpen} className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs font-bold text-[var(--accent)]" aria-label={`View full recipe for ${meal.name}`}>Details</button>
    </div>
    <p className="mt-3 line-clamp-3 whitespace-pre-line break-words text-sm leading-6 text-[var(--dim)]">{meal.summary}</p>
    {actions}
  </article>;
}

/**
 * Details for the meal with `mealKey`, looked up in the current (refetched)
 * list, so an edit shows the new text and a deleted meal shows as removed.
 */
export function MealDetailsModal({ meals, mealKey, onClose }: { meals: MealItem[]; mealKey: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  const meal = meals.find((item) => item.key === mealKey) ?? null;
  return <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="recipe-title" onClick={onClose}>
    <article className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[var(--surface)] px-5 pb-safe pt-5 text-[var(--text)] shadow-2xl sm:max-w-xl sm:rounded-[var(--radius)] sm:pb-5" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {meal && <p className="text-xs font-semibold text-[var(--dim)]">{meal.origin} · {mealDate(meal.date)}</p>}
          <h2 id="recipe-title" className="mt-1 break-words text-2xl font-extrabold leading-8 tracking-[-.02em]">{meal ? meal.name : "Meal removed"}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close recipe details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xl leading-none">×</button>
      </div>
      {meal ? <>
        <section className="mt-5">
          <h3 className="section-title">Overview</h3>
          <p className="mt-2 whitespace-pre-line break-words text-sm leading-6">{meal.summary}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Ingredients</h3>
          <p className="mt-2 whitespace-pre-line break-words text-sm leading-6">{meal.ingredients}</p>
        </section>
        <section className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="section-title">Method</h3>
          {meal.instructions ? <p className="mt-2 whitespace-pre-line break-words text-sm leading-6">{meal.instructions}</p> : <p className="mt-2 text-sm leading-6 text-[var(--dim)]">Method wasn’t saved with this earlier check-in.</p>}
        </section>
      </> : <p className="mt-5 text-sm leading-6 text-[var(--dim)]">This meal is no longer in the feed.</p>}
      <button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-white">Done</button>
    </article>
  </div>;
}

const recipeMeal = (recipe: Recipe): MealItem => {
  const fromTeam = recipe.source === "team";
  return {
    key: recipe.key, name: recipe.name, summary: recipe.summary, ingredients: recipe.ingredients, instructions: recipe.instructions,
    date: recipe.updatedAt, badge: fromTeam ? "From your coach" : undefined,
    origin: fromTeam ? `From your coach${recipe.author ? ` · ${recipe.author}` : ""}` : "Daily check-in",
  };
};

/** Athlete Fuel: own check-in meals and team meals, newest first (server order). */
export function Nutrition({ recipes }: { recipes: Recipe[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const meals = recipes.map(recipeMeal);
  return <div className="space-y-3">
    <p className="text-sm leading-6 text-[var(--dim)]">Meals from your daily check-ins and from your coaches, newest first.</p>
    {meals.length === 0 ? <Empty>Meals from your daily check-ins and your coaches will appear here.</Empty> : meals.map((meal) => <MealCard key={meal.key} meal={meal} onOpen={() => setSelectedKey(meal.key)} />)}
    {selectedKey && <MealDetailsModal meals={meals} mealKey={selectedKey} onClose={() => setSelectedKey(null)} />}
  </div>;
}
