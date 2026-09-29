export type Tab = "dashboard" | "log" | "plan" | "bow" | "nutrition" | "team" | "settings";

export type NavItem = { id: Tab; label: string; mark: string };

export const athleteNav: NavItem[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "log", label: "Log", mark: "02" }, { id: "plan", label: "Plan", mark: "03" },
  { id: "bow", label: "Gear", mark: "04" }, { id: "nutrition", label: "Fuel", mark: "05" }, { id: "settings", label: "Settings", mark: "06" },
];

// Coaches have no personal training data: no Log, Plan or Gear. Today is the
// team overview and Fuel manages team meals.
export const coachNav: NavItem[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "nutrition", label: "Fuel", mark: "02" },
  { id: "team", label: "Team", mark: "03" }, { id: "settings", label: "Settings", mark: "04" },
];

// Literal class names so Tailwind generates them.
const navColumns: Record<number, string> = { 4: "grid-cols-4", 6: "grid-cols-6" };
export const navGridClass = (nav: NavItem[]) => navColumns[nav.length] ?? "grid-cols-6";

/** A tab id valid for this nav; anything else (e.g. stale state) falls back to Today. */
export const visibleTab = (nav: NavItem[], tab: Tab): Tab => nav.some((item) => item.id === tab) ? tab : "dashboard";
