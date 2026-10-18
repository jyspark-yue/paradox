// Types mirror the live Paradox FastAPI responses (backend/paradox/api/main.py).
// Every string coming from case content (statements, evidence, descriptions) is untrusted
// display data and must be rendered as text only.

export type Belief = Record<string, number>;
export type Policy = "eig" | "random" | "fixed" | "llm";
export type CaseStatus = "open" | "solved" | "inconclusive" | (string & {});
export type Variant = "A" | "B";

export interface Config {
  llm_available: boolean;
  llm_detail: string;
  policies: Policy[];
}

export interface Perturbation {
  id: string;
  label: string;
  description: string;
}

export interface CaseSummary {
  id: string;
  title: string;
  summary: string;
  suspects: string[];
  hypotheses: number;
  actions: number;
  perturbations: Perturbation[];
  variants: string[];
}

export interface StartRequest {
  variant: Variant;
  mode: "scripted" | "sampled";
  seed: number;
  perturbations: string[];
}

export interface PersonInfo {
  id: string;
  name: string;
  role: string;
  suspect: boolean;
  bio: string;
  access: string[];
}

export interface HypothesisInfo {
  id: string;
  description: string;
  prior: number;
  posterior: number;
  person_id: string;
  person_name: string;
}

export interface StatementInfo {
  id: string;
  speaker_id: string;
  speaker: string;
  content: string;
  claim_type: string;
  source: string;
  recorded_at: number;
  revision: number;
}

export interface EvidenceInfo {
  id: string;
  type: string;
  name: string;
  description: string;
  reliability: number;
  provenance: string;
  bundle: string;
  observation_id: string | null;
}

export interface ObservationInfo {
  id: string;
  seq: number;
  action_id: string;
  action_label: string;
  cost: number;
  bundle: string;
  outcome_code: string;
  outcome_label: string;
  discovered_at: number;
  evidence_id: string;
  evidence_description: string;
  reliability: number;
}

export interface Contradiction {
  id: string;
  type: string;
  rule: string;
  description: string;
  status: string;
  status_reason: string;
  subject_id: string;
  event_ids: string[];
  explained_evidence: string;
  losing_evidence: string;
  statement_ids: string[];
  evidence_ids: string[];
  travel_minutes?: number;
  gap_minutes?: number;
  confidence?: number;
}

export interface BeliefPoint {
  seq: number;
  probs: Belief;
  entropy: number;
  cause: string;
}

export interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  activity: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface DecisionCandidate {
  rank: number;
  action_id: string;
  label: string;
  expected_information_gain: number;
  cost: number;
  utility: number;
  conditioned_on: Record<string, string>;
  predicted_outcomes: { code: string; probability: number }[];
}

/** Observation as embedded in a decision. Agent steps carry `untrusted_case_content`; manual ones carry `description`. */
export interface DecisionObservation {
  id: string;
  seq?: number;
  action_id: string;
  action_label?: string;
  outcome_code: string;
  outcome_label?: string;
  evidence_id: string;
  description?: string;
  untrusted_case_content?: string;
  reliability?: number;
  provenance?: string;
  bundle?: string;
  new_statements?: string[];
}

export interface StoppingCheck {
  should_stop: boolean;
  outcome: string | null;
  reason: string;
  leader: string;
  confidence: number;
  supporting_bundles: number;
}

export interface Decision {
  seq: number;
  policy: string;
  action_id: string | null;
  kind: "investigate" | "conclude" | (string & {});
  label?: string;
  rationale: string;
  explanation: string;
  eig?: number;
  cost?: number;
  utility?: number;
  conditioned_on?: Record<string, string>;
  candidates?: DecisionCandidate[];
  focus?: {
    hypothesis: string;
    person: string;
    claim_paths: string[][];
    record_paths: string[][];
  };
  observation?: DecisionObservation;
  belief_before?: Belief;
  belief_after?: Belief;
  new_contradictions?: string[];
  status_changes?: { id: string; status: string }[];
  evidence_citations?: string[];
  stopping_before?: StoppingCheck;
  trace?: TraceEntry[];
}

export interface CaseState {
  case_id: string;
  session_id: string;
  title: string;
  summary: string;
  status: CaseStatus;
  status_reason: string;
  graph_version: number;
  budget: number;
  spent: number;
  remaining_budget: number;
  actions_taken: number;
  max_actions: number;
  confidence_threshold: number;
  min_supporting_bundles: number;
  window: string;
  simulation: string;
  perturbations: string[];
  people: PersonInfo[];
  hypotheses: HypothesisInfo[];
  statements: StatementInfo[];
  evidence: EvidenceInfo[];
  observations: ObservationInfo[];
  contradictions: Contradiction[];
  belief_history: BeliefPoint[];
  decisions: Decision[];
}

export type NodeType =
  | "Person"
  | "Evidence"
  | "Contradiction"
  | "Event"
  | "Hypothesis"
  | "Statement"
  | "Location"
  | "InvestigationAction"
  | "Observation";

export interface GraphNode {
  id: string;
  type: NodeType | (string & {});
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  props: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  graph_version: number;
}

export interface OutcomePrediction {
  code: string;
  probability: number;
  posterior_entropy: number;
  leading_after: string;
  leading_probability: number;
}

export interface ActionCandidate {
  action_id: string;
  label: string;
  type: string;
  description: string;
  cost: number;
  bundle: string;
  activity: string;
  target: string | null;
  evidence_source: string;
  location: string | null;
  distance_from_scene: number | null;
  prerequisites: string[];
  result_categories: { code: string; label: string }[];
  executed: boolean;
  eligible: boolean;
  ineligible_reasons: string[];
  eig: number;
  utility: number;
  outcome_predictions: OutcomePrediction[];
  conditioned_on: Record<string, string>;
  rank?: number;
}

export interface Bundles {
  counted: Record<string, string[]>;
  discounted: Record<string, string[]>;
}

export interface Assessment {
  leader: string;
  confidence: number;
  supporting_bundles: number;
  bundles: Bundles;
  best_eig: number;
  remaining_budget: number;
  stop: boolean;
  outcome: string | null;
  reason: string;
}

export interface ActionsResponse {
  belief: Belief;
  entropy: number;
  ranked: string[];
  candidates: ActionCandidate[];
  assessment: Assessment;
  objective: string;
}

export interface StartResponse {
  session_id: string;
  state: CaseState;
  actions: ActionCandidate[];
}

export interface StepResponse {
  done: boolean;
  status: CaseStatus;
  trace: TraceEntry[];
  decision: Decision | null;
  state?: CaseState;
}

export interface InvestigateResponse {
  charged: boolean;
  already_executed: boolean;
  observation: DecisionObservation;
  graph_version: number;
  remaining_budget: number;
  hypotheses?: { before: Belief; after: Belief; caused_by: string };
  new_contradictions?: Contradiction[];
  assessment?: Assessment;
  status?: CaseStatus;
  remaining_actions?: string[];
}

export interface HistoryResponse {
  observations: ObservationInfo[];
  belief_history: BeliefPoint[];
  decisions: Decision[];
}

export interface CriticalEvidence {
  path: string[];
  action: string;
  evidence: string;
  bundle: string;
  reliability: number;
  likelihood_ratio: number;
  seq: number;
}

export interface ReportHistoryItem {
  seq: number;
  action_id: string;
  action: string;
  cost: number;
  outcome: string;
  evidence: string;
  belief_before: Belief;
  belief_after: Belief;
  policy: string;
  rationale: string;
}

export interface GroundTruth {
  sealed: boolean;
  note?: string;
  truth?: string;
  variant?: string;
  mode?: string;
  narrative?: string;
  leading_matches_truth?: boolean;
  correct_solve?: boolean;
}

export interface Report {
  case_id: string;
  title: string;
  status: CaseStatus;
  outcome: string | null;
  status_reason: string;
  conclusion: string;
  leading_hypothesis: string;
  confidence: number;
  confidence_note: string;
  suspect_ranking: { hypothesis: string; description: string; person: string; probability: number }[];
  critical_evidence: CriticalEvidence[];
  supporting_bundles: Bundles;
  contradictions: Contradiction[];
  contradiction_paths: { path: string[]; statement: string; evidence: string; contradiction_id: string }[];
  investigation_history: ReportHistoryItem[];
  remaining_uncertainty: {
    entropy_bits: number;
    runner_up: { hypothesis: string; probability: number } | null;
    unresolved_contradictions: string[];
    unexplored_actions: { action_id: string; label: string; eig: number }[];
  };
  total_cost: number;
  budget: number;
  actions_taken: number;
  graph_version: number;
  ground_truth?: GroundTruth;
}

export type RunEvent =
  | { event: "step"; data: StepResponse }
  | { event: "report"; data: Report }
  | { event: "halted"; data: { detail: string } };
