export type Tab = "dashboard" | "log" | "plan" | "bow" | "nutrition" | "team" | "settings";

export const athleteNav: { id: Tab; label: string; mark: string }[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "log", label: "Log", mark: "02" }, { id: "plan", label: "Plan", mark: "03" },
  { id: "bow", label: "Gear", mark: "04" }, { id: "nutrition", label: "Fuel", mark: "05" }, { id: "settings", label: "Settings", mark: "06" },
];

export const coachNav: { id: Tab; label: string; mark: string }[] = [
  { id: "dashboard", label: "Today", mark: "01" }, { id: "log", label: "Log", mark: "02" }, { id: "plan", label: "Plan", mark: "03" },
  { id: "bow", label: "Gear", mark: "04" }, { id: "nutrition", label: "Fuel", mark: "05" }, { id: "team", label: "Team", mark: "06" },
  { id: "settings", label: "Settings", mark: "07" },
];
