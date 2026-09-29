// Team meals (0003 §3): recipes a coach posts once for the whole team. Every
// active athlete sees every meal in Fuel, merged into the tracker payload's
// `recipes[]`. Any coach may edit or delete any meal; concurrent edits are
// last-write-wins. Team data, not an athlete's: never exported or imported.
// Authors appear only by display name ("Coach" once the account is deleted);
// user ids are never returned.

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { schema, type Db } from "../db";
import type { TeamMealInput } from "../lib/validation";

/** Shown in place of the author's name after their account was deleted. */
export const DELETED_AUTHOR_NAME = "Coach";

const meals = schema.teamMeals;
const author = alias(schema.users, "author");
const editor = alias(schema.users, "editor");

function selectMeals(db: Db) {
  return db.select({
    id: meals.id,
    name: meals.name,
    summary: meals.summary,
    ingredients: meals.ingredients,
    instructions: meals.instructions,
    createdAt: meals.createdAt,
    updatedAt: meals.updatedAt,
    authorName: author.username,
    editorName: editor.username,
  }).from(meals)
    .leftJoin(author, eq(author.id, meals.authorId))
    .leftJoin(editor, eq(editor.id, meals.updatedBy));
}

type MealRow = Awaited<ReturnType<typeof selectMeals>>[number];

function toTeamMeal(row: MealRow) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    ingredients: row.ingredients,
    instructions: row.instructions,
    /** Display name of the posting coach, or "Coach" once that account is deleted. */
    author: row.authorName ?? DELETED_AUTHOR_NAME,
    /** Display name of the last editor; null if never edited, "Coach" if that account is deleted. */
    updatedBy: row.editorName ?? (row.updatedAt.getTime() === row.createdAt.getTime() ? null : DELETED_AUTHOR_NAME),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type TeamMeal = ReturnType<typeof toTeamMeal>;

/** Every team meal, newest first by creation (edits never reorder). */
export async function listTeamMeals(db: Db): Promise<TeamMeal[]> {
  const rows = await selectMeals(db).orderBy(desc(meals.createdAt), desc(meals.id));
  return rows.map(toTeamMeal);
}

/** Team meals in the shape the athlete tracker payload merges into `recipes[]`. */
export async function listTeamMealRecipes(db: Db) {
  return (await listTeamMeals(db)).map((meal) => ({
    id: meal.id,
    name: meal.name,
    summary: meal.summary,
    ingredients: meal.ingredients,
    instructions: meal.instructions,
    author: meal.author,
    createdAt: meal.createdAt,
    updatedAt: meal.updatedAt,
  }));
}

async function getTeamMeal(db: Db, id: number): Promise<TeamMeal | null> {
  const rows = await selectMeals(db).where(eq(meals.id, id)).limit(1);
  return rows[0] ? toTeamMeal(rows[0]) : null;
}

export async function createTeamMeal(db: Db, coach: { id: string; username: string }, input: TeamMealInput): Promise<TeamMeal> {
  const now = new Date();
  const [row] = await db.insert(meals).values({ authorId: coach.id, updatedBy: null, ...input, createdAt: now, updatedAt: now })
    .returning({ id: meals.id });
  return {
    id: row.id, ...input, author: coach.username, updatedBy: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

/** Full replace of the four text fields by any coach. Null when no such meal. */
export async function updateTeamMeal(db: Db, id: number, coachId: string, input: TeamMealInput): Promise<TeamMeal | null> {
  const updated = await db.update(meals).set({ ...input, updatedBy: coachId, updatedAt: new Date() })
    .where(eq(meals.id, id)).returning({ id: meals.id });
  if (!updated.length) return null;
  return getTeamMeal(db, id);
}

/** Deletes a meal by any coach. False when no such meal. */
export async function deleteTeamMeal(db: Db, id: number): Promise<boolean> {
  const deleted = await db.delete(meals).where(eq(meals.id, id)).returning({ id: meals.id });
  return deleted.length > 0;
}
