// Checklists: milestone checks, the maintenance checklist items per section
// and their checked state. Private to the athlete.

import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { CheckInput, MaintenanceItemInput, MaintenanceSection } from "../lib/validation";

export async function setCheckFor(db: Db, userId: string, input: CheckInput) {
  const table = input.group === "milestone" ? schema.milestoneChecks : schema.maintenanceChecks;
  await db.insert(table).values({ userId, key: input.key, checked: input.checked, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [table.userId, table.key], set: { checked: input.checked, updatedAt: new Date() } });
  return { ok: true as const };
}

export async function addMaintenanceItemFor(db: Db, userId: string, input: MaintenanceItemInput) {
  const result = await db.insert(schema.maintenanceItems).values({
    userId,
    section: input.section,
    label: input.label,
    sortOrder: sql`COALESCE((SELECT MAX(sort_order) + 1 FROM maintenance_items
      WHERE user_id = ${userId} AND section = ${input.section}), 0)`,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning({ id: schema.maintenanceItems.id });
  const row = result[0];
  if (!row) throw new Error("Maintenance item could not be saved");
  return { id: row.id };
}

export async function updateMaintenanceItemFor(db: Db, userId: string, id: number, label: string) {
  const result = await db.update(schema.maintenanceItems).set({ label, updatedAt: new Date() })
    .where(and(eq(schema.maintenanceItems.id, id), eq(schema.maintenanceItems.userId, userId)));
  if (result.meta.changes === 0) return null;
  return { ok: true as const };
}

export async function deleteMaintenanceItemFor(db: Db, userId: string, id: number) {
  const [, deleted] = await db.batch([
    db.delete(schema.maintenanceChecks).where(and(eq(schema.maintenanceChecks.key, `item:${id}`), eq(schema.maintenanceChecks.userId, userId))),
    db.delete(schema.maintenanceItems).where(and(eq(schema.maintenanceItems.id, id), eq(schema.maintenanceItems.userId, userId))),
  ]);
  if (deleted.meta.changes === 0) return null;
  return { ok: true as const };
}

export async function setMaintenanceItemCheckedFor(db: Db, userId: string, id: number, checked: boolean) {
  await db.insert(schema.maintenanceChecks).values({ userId, key: `item:${id}`, checked, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.maintenanceChecks.userId, schema.maintenanceChecks.key],
      set: { checked, updatedAt: new Date() },
    });
  return { ok: true as const };
}

export async function clearMaintenanceSectionFor(db: Db, userId: string, section: MaintenanceSection) {
  await db.run(sql`
    INSERT INTO maintenance_checks (user_id, key, checked, updated_at)
    SELECT user_id, 'item:' || id, 0, ${Date.now()} FROM maintenance_items
    WHERE user_id = ${userId} AND section = ${section}
    ON CONFLICT (user_id, key) DO UPDATE SET checked = 0, updated_at = excluded.updated_at
  `);
  return { ok: true as const };
}
