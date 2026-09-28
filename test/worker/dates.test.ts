import { describe, expect, it } from "vitest";
import { addUtcDays, dateKeyUtc, datedProgramState, isoWeekKey, mondayDate, shiftProgramState } from "../../src/lib/dates";
import { buildContentDisposition } from "../../src/lib/http";
import { parseContentDisposition } from "./tracker-fixtures";

describe("calendar helpers", () => {
  it.each([
    ["2016-01-04", "2016-W01"], ["2021-01-04", "2021-W01"], ["2027-01-04", "2027-W01"],
    ["2021-12-31", "2021-W52"], ["2021-01-01", "2020-W53"], ["2020-12-31", "2020-W53"],
    ["2018-12-31", "2019-W01"], ["2024-02-29", "2024-W09"], ["2016-12-31", "2016-W52"],
  ])("labels %s as %s", (day, week) => expect(isoWeekKey(day)).toBe(week));
  it("advances across a cycle and clamps dates before its anchor", () => {
    const state = { currentCycle: 1, currentWeek: 6, updatedAt: new Date("2026-09-21T12:00:00Z") };
    expect(datedProgramState(state, "2026-09-28")).toEqual({ currentCycle: 2, currentWeek: 1 });
    expect(datedProgramState(state, "2026-09-01")).toEqual({ currentCycle: 1, currentWeek: 6 });
    expect(shiftProgramState({ currentCycle: 1, currentWeek: 1 }, -100)).toEqual({ currentCycle: 1, currentWeek: 1 });
    expect(shiftProgramState({ currentCycle: 2, currentWeek: 1 }, -1)).toEqual({ currentCycle: 1, currentWeek: 6 });
  });
  it("keeps date arithmetic at noon across Sunday, leap day and year boundaries", () => {
    expect(mondayDate("2027-01-03").toISOString()).toBe("2026-12-28T12:00:00.000Z");
    expect(dateKeyUtc(addUtcDays(new Date("2024-02-28T12:00:00Z"), 1))).toBe("2024-02-29");
  });
});

it.each(['Élan "plan"', 'a"; filename="evil.html"; x="/../../b\\c', 'line\r\nbreak', '\ud800broken']) (
  "builds a single safe download filename", (label) => {
    const header = buildContentDisposition(label, "application/pdf");
    const { fallback, decoded } = parseContentDisposition(header);
    expect(fallback).toMatch(/^[\x20-\x7E]+\.pdf$/);
    expect(fallback).not.toMatch(/["\\/\r\n]/);
    expect(decoded).not.toMatch(/[\\/\r\n]/);
    expect(decoded).toMatch(/\.pdf$/);
  },
);
