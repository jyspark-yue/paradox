import type { ElementDefinition } from "cytoscape";
import type { GraphData, GraphEdge, GraphNode } from "../api/types";

export const NODE_TYPES = [
  "Person",
  "Hypothesis",
  "Statement",
  "Evidence",
  "Contradiction",
  "Event",
  "InvestigationAction",
  "Observation",
  "Location",
] as const;
export type KnownNodeType = (typeof NODE_TYPES)[number];

export const TYPE_META: Record<KnownNodeType, { label: string; color: string }> = {
  Person: { label: "Person", color: "#5b9cf5" },
  Hypothesis: { label: "Hypothesis", color: "#a78bfa" },
  Statement: { label: "Statement", color: "#2dd4bf" },
  Evidence: { label: "Evidence", color: "#e3b341" },
  Contradiction: { label: "Contradiction", color: "#f05252" },
  Event: { label: "Event", color: "#9aa3b2" },
  InvestigationAction: { label: "Action", color: "#34d399" },
  Observation: { label: "Observation", color: "#f0abfc" },
  Location: { label: "Location", color: "#64748b" },
};

export const DEFAULT_VISIBLE: KnownNodeType[] = [
  "Person",
  "Hypothesis",
  "Statement",
  "Evidence",
  "Contradiction",
  "Event",
  "InvestigationAction",
];

export const CONTRADICTION_EDGES = new Set(["CONTRADICTS", "CONFLICTS_WITH", "INVOLVES"]);

export interface GraphFilters {
  types: Set<string>;
  showUnexecutedActions: boolean;
  showUndiscoveredEvidence: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function nodeLabel(n: GraphNode, names: Map<string, string>): string {
  const p = n.properties;
  switch (n.type) {
    case "Person":
      return str(p.name) || n.id;
    case "Hypothesis": {
      const post = typeof p.posterior_probability === "number" ? p.posterior_probability : null;
      return `${n.id}${post !== null ? ` · ${Math.round(post * 100)}%` : ""}\n${clip(str(p.description), 34)}`;
    }
    case "Statement": {
      const who = names.get(str(p.speaker_id)) ?? str(p.speaker_id);
      return `${who.replace(/^Dr\.\s+/, "")}: “${clip(str(p.content), 38)}”`;
    }
    case "Evidence":
      return p.discovered ? clip(str(p.name), 36) : `${clip(str(p.name), 30)}\n(undiscovered)`;
    case "Contradiction":
      return `Contradiction ${str(p.rule)}\n${str(p.status)}`;
    case "Event":
      return clip(str(p.description) || n.id, 44);
    case "InvestigationAction":
      return clip(str(p.label) || n.id, 36);
    case "Observation":
      return clip(str(p.outcome_label) || n.id, 34);
    case "Location":
      return str(p.name) || n.id;
    default:
      return n.id;
  }
}

export function nodeClasses(n: GraphNode): string[] {
  const p = n.properties;
  const cls = [`t-${n.type}`];
  if (n.type === "Evidence") cls.push(p.discovered ? "discovered" : "undiscovered");
  if (n.type === "InvestigationAction") cls.push(p.executed ? "executed" : "unexecuted");
  if (n.type === "Event") cls.push(p.status === "recorded" ? "recorded" : "alleged");
  if (n.type === "Contradiction") cls.push(`k-${str(p.status) || "unknown"}`);
  if (n.type === "Person" && p.suspect === false) cls.push("bystander");
  return cls;
}

export function edgeKeyList(edges: GraphEdge[]): string[] {
  const seen = new Map<string, number>();
  return edges.map((e) => {
    const base = `${e.source}|${e.type}|${e.target}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k ? `${base}#${k}` : base;
  });
}

export function toElements(g: GraphData): { nodes: ElementDefinition[]; edges: ElementDefinition[] } {
  const names = new Map<string, string>();
  for (const n of g.nodes) if (n.type === "Person") names.set(n.id, str(n.properties.name));
  const ids = new Set(g.nodes.map((n) => n.id));
  const nodes: ElementDefinition[] = g.nodes.map((n) => {
    const post = n.type === "Hypothesis" && typeof n.properties.posterior_probability === "number"
      ? n.properties.posterior_probability
      : 0;
    return {
      group: "nodes",
      data: { id: n.id, type: n.type, label: nodeLabel(n, names), size: 34 + 46 * post },
      classes: nodeClasses(n),
    };
  });
  const keys = edgeKeyList(g.edges);
  const edges: ElementDefinition[] = [];
  g.edges.forEach((e, i) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return;
    const cls = [`e-${e.type}`];
    if (CONTRADICTION_EDGES.has(e.type)) cls.push("contra-edge");
    edges.push({
      group: "edges",
      data: { id: `e:${keys[i]}`, source: e.source, target: e.target, type: e.type, label: e.type },
      classes: cls,
    });
  });
  return { nodes, edges };
}

/** Signature used to decide whether a node "appeared" since the last version (new, newly discovered, newly executed). */
export function appearanceSig(n: GraphNode): string {
  const p = n.properties;
  if (n.type === "Evidence") return p.discovered ? "on" : "off";
  if (n.type === "InvestigationAction") return p.executed ? "on" : "off";
  if (n.type === "Contradiction") return str(p.status);
  return "on";
}

export function isNodeVisible(n: { type: string; classes: string[] }, f: GraphFilters): boolean {
  if (!f.types.has(n.type)) return false;
  if (n.type === "InvestigationAction" && !f.showUnexecutedActions && n.classes.includes("unexecuted")) return false;
  if (n.type === "Evidence" && !f.showUndiscoveredEvidence && n.classes.includes("undiscovered")) return false;
  return true;
}
