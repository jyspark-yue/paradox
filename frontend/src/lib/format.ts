import type { Belief, CaseState, Decision, ObservationInfo } from "../api/types";

export const pct = (p: number | undefined | null, digits = 0) =>
  p === undefined || p === null || Number.isNaN(p) ? "—" : `${(p * 100).toFixed(digits)}%`;

export const bits = (b: number | undefined | null, digits = 3) =>
  b === undefined || b === null || Number.isNaN(b) ? "—" : `${b.toFixed(digits)} bits`;

export const num = (n: number | undefined | null, digits = 3) =>
  n === undefined || n === null || Number.isNaN(n) ? "—" : n.toFixed(digits);

/** Minutes since midnight (backend time encoding) → "8:41 PM". */
export function clock(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null || Number.isNaN(minutes)) return "—";
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

export const leaderOf = (b: Belief): [string, number] | null => {
  const entries = Object.entries(b);
  if (!entries.length) return null;
  return entries.reduce((a, c) => (c[1] > a[1] ? c : a));
};

export const shortName = (name: string) => name.replace(/^Dr\.\s+/, "").split(/\s+/)[0] ?? name;

export type Phase = "Idle" | "Investigating" | "Solved" | "Inconclusive";

export function phaseOf(state: CaseState | null, running: boolean): Phase {
  if (!state) return "Idle";
  if (state.status === "solved") return "Solved";
  if (state.status === "inconclusive") return "Inconclusive";
  if (running || state.actions_taken > 0) return "Investigating";
  return "Idle";
}

/** Text of the observation embedded in a decision (agent: untrusted_case_content; manual: description). */
export function observationText(d: Decision, observations: ObservationInfo[]): string {
  const o = d.observation;
  if (!o) return "";
  return (
    o.untrusted_case_content ??
    o.description ??
    observations.find((x) => x.id === o.id)?.evidence_description ??
    ""
  );
}

export function outcomeLabel(d: Decision, observations: ObservationInfo[]): string {
  const o = d.observation;
  if (!o) return "";
  return o.outcome_label ?? observations.find((x) => x.id === o.id)?.outcome_label ?? o.outcome_code;
}

export const humanize = (s: string) => s.replace(/_/g, " ");
