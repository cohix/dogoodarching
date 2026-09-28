import { type PlannedSession } from "../../api";

// The API always returns all seven days (defaults merged with saved overrides),
// so this fallback is only used if the payload is empty. It mirrors the
// neutral starter template in src/services/plan.ts (plannedSessionDefaults).
const starterPlan = [
  { dayKey: "mon", day: "Monday", short: "Mon", sessionType: "Practice", detail: "Technique practice", prescription: "Choose a focus for your practice.", updatedAt: null, attachments: [] },
  { dayKey: "tue", day: "Tuesday", short: "Tue", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals.", updatedAt: null, attachments: [] },
  { dayKey: "wed", day: "Wednesday", short: "Wed", sessionType: "Practice", detail: "Skills practice", prescription: "Choose a skill to work on.", updatedAt: null, attachments: [] },
  { dayKey: "thu", day: "Thursday", short: "Thu", sessionType: "Review", detail: "Review your progress", prescription: "Reflect on your practice and update your plan.", updatedAt: null, attachments: [] },
  { dayKey: "fri", day: "Friday", short: "Fri", sessionType: "Activity", detail: "General activity", prescription: "Choose an activity that suits your goals.", updatedAt: null, attachments: [] },
  { dayKey: "sat", day: "Saturday", short: "Sat", sessionType: "Practice", detail: "Open practice", prescription: "Plan a session around your current goals.", updatedAt: null, attachments: [] },
  { dayKey: "sun", day: "Sunday", short: "Sun", sessionType: "Rest", detail: "Rest and reflect", prescription: "Take time to rest and plan the week ahead.", updatedAt: null, attachments: [] },
] satisfies PlannedSession[];

export function plannedSessionsFor(data: { plannedSessions: PlannedSession[] }): PlannedSession[] { return data.plannedSessions.length ? data.plannedSessions : starterPlan; }

/** True while every day still shows the starter template (no day has been saved by the athlete or a coach). */
export function isStarterPlan(plannedSessions: PlannedSession[]): boolean { return plannedSessions.every((session) => session.updatedAt === null); }

export type CyclePlanItem = { weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string };

const defaultCycle: CyclePlanItem[] = [
  { weekNumber: 1, primaryFocus: "Back Activation", backgroundFocusOne: "Posture / stance", backgroundFocusTwo: "String-hand hook / draw" },
  { weekNumber: 2, primaryFocus: "Relaxed Bow Hand", backgroundFocusOne: "Core engagement / stance", backgroundFocusTwo: "Facial reference / anchor" },
  { weekNumber: 3, primaryFocus: "Head Position", backgroundFocusOne: "Nocking / pre-shot", backgroundFocusTwo: "Endurance hold / follow-through" },
  { weekNumber: 4, primaryFocus: "Thoracic Rotation", backgroundFocusOne: "Setup / stance", backgroundFocusTwo: "Timing / execution" },
  { weekNumber: 5, primaryFocus: "Hip Stability", backgroundFocusOne: "One-eye aiming", backgroundFocusTwo: "Follow-through / execution" },
  { weekNumber: 6, primaryFocus: "Release", backgroundFocusOne: "Self-talk / mental", backgroundFocusTwo: "Practice score / simulation" },
];

export function cyclePlanFor(data: { weeklyPlans: { weekNumber: number; primaryFocus: string; backgroundFocusOne: string; backgroundFocusTwo: string }[] }): CyclePlanItem[] {
  return defaultCycle.map((fallback) => {
    const saved = data.weeklyPlans.find((plan) => plan.weekNumber === fallback.weekNumber);
    return saved ? { weekNumber: saved.weekNumber, primaryFocus: saved.primaryFocus, backgroundFocusOne: saved.backgroundFocusOne, backgroundFocusTwo: saved.backgroundFocusTwo } : fallback;
  });
}

export const milestones = [
  { weight: 24, target: "Consolidate now", note: "Full stabilizer · clicker after static draw-length check", tasks: ["Integrate full stabilizer setup", "Add clicker once draw length is verified static", "Bare-shaft tune at 24 lb", "Complete walk-back tune", "Record sight marks through 70 m"] },
  { weight: 28, target: "Target Nov 2026", note: "Automate stabilizer + clicker for outdoor season", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
  { weight: 32, target: "Target Feb 2027", note: "Transition to micro-diameter arrows", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
  { weight: 34, target: "Target May 2027", note: "Competition setup", tasks: ["Clicker fires on back tension for 3 straight sessions", "Steady full-draw hold", "Consistent groups", "Clean bare-shaft tune"] },
];
