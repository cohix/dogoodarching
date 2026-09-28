/**
 * Work item 0001 section 7 (A7): clearing a maintenance section is one atomic,
 * idempotent statement, and `sort_order` is computed inside the insert so
 * concurrent adds never collide.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db";
import { addMaintenanceItemFor } from "../../src/services/maintenance";
import { api, apiJson, type Session } from "./helpers";
import { addItem, checkItem, count, post, rows, setupAthletes, tracker } from "./tracker-fixtures";

type Section = "Weekly" | "Monthly" | "Quarterly";

const clear = (session: Session, section: string) =>
  apiJson("/api/maintenance/sections/clear", { json: { section }, cookie: session.cookie });

async function checkedById(session: Session): Promise<Record<number, boolean>> {
  const payload = await tracker(session, { today: "2026-09-28" });
  return Object.fromEntries(payload.maintenanceItems.map((item) => [item.id, item.checked]));
}

/** Check rows without their timestamps, which a repeated clear may refresh. */
const checkRows = () => rows("SELECT user_id, key, checked FROM maintenance_checks ORDER BY user_id, key");

interface Order { id: number; sort_order: number; label: string }

const orders = (userId: string, section: Section) =>
  rows<Order>("SELECT id, sort_order, label FROM maintenance_items WHERE user_id = ? AND section = ? ORDER BY sort_order, id", userId, section);

describe("maintenance section clear", () => {
  it("unchecks every item in the section and nothing else", async () => {
    const { athlete, rival } = await setupAthletes();
    const weeklyA = await addItem(athlete, "Weekly", "Wax the string");
    const weeklyB = await addItem(athlete, "Weekly", "Check nocking point");
    const weeklyNever = await addItem(athlete, "Weekly", "Never ticked");
    const monthly = await addItem(athlete, "Monthly", "Check limb bolts");
    const theirs = await addItem(rival, "Weekly", "Wax the string");
    for (const id of [weeklyA, weeklyB, monthly]) await checkItem(athlete, id, true);
    await checkItem(rival, theirs, true);
    await post(athlete, "/api/checks", { group: "milestone", key: "first-30m", checked: true });

    const response = await clear(athlete, "Weekly");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(await checkedById(athlete)).toEqual({ [weeklyA]: false, [weeklyB]: false, [weeklyNever]: false, [monthly]: true });
    expect(await checkedById(rival)).toEqual({ [theirs]: true });
    expect(await rows("SELECT key, checked FROM milestone_checks WHERE user_id = ?", athlete.user.id)).toEqual([{ key: "first-30m", checked: 1 }]);
    // Items themselves are untouched.
    expect(await count("maintenance_items", "user_id = ?", athlete.user.id)).toBe(4);
    expect((await orders(athlete.user.id, "Weekly")).map((row) => row.label)).toEqual(["Wax the string", "Check nocking point", "Never ticked"]);
  });

  it("is idempotent: repeating the clear changes nothing and adds no rows", async () => {
    const { athlete } = await setupAthletes();
    const ids = [await addItem(athlete, "Quarterly", "Replace string"), await addItem(athlete, "Quarterly", "Inspect limbs"), await addItem(athlete, "Quarterly", "Service plunger")];
    await checkItem(athlete, ids[0] as number, true);
    await checkItem(athlete, ids[1] as number, true);

    expect((await clear(athlete, "Quarterly")).status).toBe(200);
    const afterFirst = await checkRows();
    const stateAfterFirst = await checkedById(athlete);

    for (let repeat = 0; repeat < 3; repeat++) {
      const again = await clear(athlete, "Quarterly");
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true });
    }

    expect(await checkRows()).toEqual(afterFirst);
    expect(await checkedById(athlete)).toEqual(stateAfterFirst);
    expect(afterFirst).toEqual(ids.map((id) => ({ user_id: athlete.user.id, key: `item:${id}`, checked: 0 })));
  });

  it("stays consistent when the same section is cleared concurrently", async () => {
    const { athlete } = await setupAthletes();
    const ids: number[] = [];
    for (let index = 0; index < 6; index++) ids.push(await addItem(athlete, "Weekly", `Item ${index}`));
    for (const id of ids) await checkItem(athlete, id, true);

    const responses = await Promise.all(Array.from({ length: 5 }, () => clear(athlete, "Weekly")));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await checkRows()).toEqual(ids.map((id) => ({ user_id: athlete.user.id, key: `item:${id}`, checked: 0 })).sort((a, b) => a.key.localeCompare(b.key)));
  });

  it("clearing an empty section succeeds and writes nothing", async () => {
    const { athlete } = await setupAthletes();
    const monthly = await addItem(athlete, "Monthly", "Check limb bolts");
    await checkItem(athlete, monthly, true);

    const response = await clear(athlete, "Weekly");

    expect(response.status).toBe(200);
    expect(await checkRows()).toEqual([{ user_id: athlete.user.id, key: `item:${monthly}`, checked: 1 }]);
  });

  it("items can be re-checked after a clear, and cleared again", async () => {
    const { athlete } = await setupAthletes();
    const id = await addItem(athlete, "Weekly", "Wax the string");
    await checkItem(athlete, id, true);
    await clear(athlete, "Weekly");
    await checkItem(athlete, id, true);
    expect(await checkedById(athlete)).toEqual({ [id]: true });

    await clear(athlete, "Weekly");

    expect(await checkedById(athlete)).toEqual({ [id]: false });
    expect(await count("maintenance_checks")).toBe(1);
  });

  it("overrides a legacy label-keyed check so the item reads as unchecked", async () => {
    const { athlete } = await setupAthletes();
    const id = await addItem(athlete, "Weekly", "Wax the string");
    // Pre-item data model: checks were keyed `<section>:<label>`.
    await post(athlete, "/api/checks", { group: "maintenance", key: "Weekly:Wax the string", checked: true });
    expect(await checkedById(athlete)).toEqual({ [id]: true });

    await clear(athlete, "Weekly");
    await clear(athlete, "Weekly");

    expect(await checkedById(athlete)).toEqual({ [id]: false });
  });

  it.each([{ section: "Daily" }, { section: "weekly" }, { section: "" }, {}, { section: null }])("rejects %j with 400 and changes nothing", async (body) => {
    const { athlete } = await setupAthletes();
    const id = await addItem(athlete, "Weekly", "Wax the string");
    await checkItem(athlete, id, true);

    const response = await apiJson("/api/maintenance/sections/clear", { json: body, cookie: athlete.cookie });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
    expect(await checkedById(athlete)).toEqual({ [id]: true });
  });

  it("requires a session", async () => {
    expect((await api("/api/maintenance/sections/clear", { json: { section: "Weekly" } })).status).toBe(401);
  });
});

describe("maintenance item sort_order", () => {
  it("numbers sequential adds 0, 1, 2 … per section", async () => {
    const { athlete } = await setupAthletes();
    for (const label of ["a", "b", "c"]) await addItem(athlete, "Weekly", label);
    await addItem(athlete, "Monthly", "m");

    expect((await orders(athlete.user.id, "Weekly")).map((row) => [row.label, row.sort_order])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect((await orders(athlete.user.id, "Monthly")).map((row) => [row.label, row.sort_order])).toEqual([["m", 0]]);
  });

  it("stays unique and gap-free under concurrent Promise.all adds over HTTP", async () => {
    const { athlete } = await setupAthletes();
    const labels = Array.from({ length: 16 }, (_unused, index) => `Concurrent ${index}`);

    const responses = await Promise.all(labels.map((label) =>
      apiJson<{ id: number }>("/api/maintenance/items", { json: { section: "Weekly", label }, cookie: athlete.cookie })));

    expect(responses.map((response) => response.status)).toEqual(labels.map(() => 200));
    const stored = await orders(athlete.user.id, "Weekly");
    expect(stored.map((row) => row.sort_order)).toEqual(labels.map((_label, index) => index));
    expect(new Set(stored.map((row) => row.label))).toEqual(new Set(labels));
    // Insertion order (id) and display order (sort_order) agree.
    expect(stored.map((row) => row.id)).toEqual([...stored.map((row) => row.id)].sort((a, b) => a - b));
    // The dashboard lists them in that order.
    const payload = await tracker(athlete, { today: "2026-09-28" });
    expect(payload.maintenanceItems.map((item) => item.id)).toEqual(stored.map((row) => row.id));
  });

  it("stays unique per user and section when users and sections are mixed concurrently", async () => {
    const { athlete, rival } = await setupAthletes();
    const sections: Section[] = ["Weekly", "Monthly", "Quarterly"];
    const requests = Array.from({ length: 24 }, (_unused, index) => ({
      session: index % 2 === 0 ? athlete : rival,
      section: sections[index % 3] as Section,
      label: `Mixed ${index}`,
    }));

    const responses = await Promise.all(requests.map(({ session, section, label }) =>
      api("/api/maintenance/items", { json: { section, label }, cookie: session.cookie })));

    expect(responses.map((response) => response.status)).toEqual(requests.map(() => 200));
    for (const session of [athlete, rival]) {
      for (const section of sections) {
        const stored = await orders(session.user.id, section);
        expect(stored.map((row) => row.sort_order), `${session.user.username} ${section}`).toEqual([0, 1, 2, 3]);
      }
    }
    expect(await count("maintenance_items")).toBe(24);
  });

  it("stays unique under concurrent adds that bypass HTTP (service level)", async () => {
    const { athlete } = await setupAthletes();
    const db = getDb(env.DB);

    const created = await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
      addMaintenanceItemFor(db, athlete.user.id, { section: "Monthly", label: `Service ${index}` })));

    expect(new Set(created.map((row) => row.id)).size).toBe(20);
    expect((await orders(athlete.user.id, "Monthly")).map((row) => row.sort_order)).toEqual(Array.from({ length: 20 }, (_unused, index) => index));
  });

  it("appends after the current maximum, keeping gaps left by deletes", async () => {
    const { athlete } = await setupAthletes();
    const ids: number[] = [];
    for (const label of ["a", "b", "c", "d"]) ids.push(await addItem(athlete, "Weekly", label));
    // Delete from the middle, then the tail.
    expect((await api(`/api/maintenance/items/${ids[1]}`, { method: "DELETE", cookie: athlete.cookie })).status).toBe(200);
    await addItem(athlete, "Weekly", "e");
    expect((await orders(athlete.user.id, "Weekly")).map((row) => [row.label, row.sort_order])).toEqual([["a", 0], ["c", 2], ["d", 3], ["e", 4]]);

    expect((await api(`/api/maintenance/items/${ids[3]}`, { method: "DELETE", cookie: athlete.cookie })).status).toBe(200);
    const [first, second] = await Promise.all([addItem(athlete, "Weekly", "f"), addItem(athlete, "Weekly", "g")]);

    const stored = await orders(athlete.user.id, "Weekly");
    expect(new Set(stored.map((row) => row.sort_order)).size).toBe(stored.length);
    expect(stored.map((row) => row.sort_order)).toEqual([0, 2, 4, 5, 6]);
    expect(stored.slice(-2).map((row) => row.id).sort((a, b) => a - b)).toEqual([first, second].sort((a, b) => a - b));
  });

  it("restarts at 0 once a section is emptied, independently of other sections", async () => {
    const { athlete } = await setupAthletes();
    const only = await addItem(athlete, "Weekly", "only");
    await addItem(athlete, "Monthly", "m0");
    await addItem(athlete, "Monthly", "m1");
    expect((await api(`/api/maintenance/items/${only}`, { method: "DELETE", cookie: athlete.cookie })).status).toBe(200);

    await addItem(athlete, "Weekly", "again");

    expect((await orders(athlete.user.id, "Weekly")).map((row) => [row.label, row.sort_order])).toEqual([["again", 0]]);
    expect((await orders(athlete.user.id, "Monthly")).map((row) => row.sort_order)).toEqual([0, 1]);
  });
});
