// Practice scores: ten ends of three arrows each. Private to the athlete.

import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { PracticeScoreInput } from "../lib/validation";

export async function addPracticeScoreFor(db: Db, userId: string, input: PracticeScoreInput) {
  const total = input.ends.reduce((sum, arrows) => sum + arrows.reduce((endSum, value) => endSum + value, 0), 0);
  // The first batch statement advances this AUTOINCREMENT table's sequence.
  // Ends read that ID inside the same atomic batch; inserting ends does not
  // change the score sequence (unlike last_insert_rowid()).
  const scoreId = sql<number>`(SELECT id FROM practice_scores
    WHERE user_id = ${userId}
      AND id = (SELECT seq FROM sqlite_sequence WHERE name = 'practice_scores'))`;
  const [inserted] = await db.batch([
    db.insert(schema.practiceScores)
      .values({ userId, scoreDate: input.scoreDate, total, createdAt: new Date() })
      .returning({ id: schema.practiceScores.id }),
    db.insert(schema.practiceScoreEnds).values(input.ends.map((arrows, index) => ({
      userId,
      scoreId,
      endNumber: index + 1,
      arrow1: arrows[0],
      arrow2: arrows[1],
      arrow3: arrows[2],
      endTotal: arrows[0] + arrows[1] + arrows[2],
    }))),
  ]);
  const score = inserted[0];
  if (!score) throw new Error("Practice score could not be saved");
  return { id: score.id, total, averageArrow: total / 30 };
}

export async function deletePracticeScoreFor(db: Db, userId: string, id: number) {
  const [, deleted] = await db.batch([
    db.delete(schema.practiceScoreEnds).where(and(eq(schema.practiceScoreEnds.scoreId, id), eq(schema.practiceScoreEnds.userId, userId))),
    db.delete(schema.practiceScores).where(and(eq(schema.practiceScores.id, id), eq(schema.practiceScores.userId, userId))),
  ]);
  if (deleted.meta.changes === 0) return null;
  return { ok: true as const };
}
