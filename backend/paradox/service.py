"""Investigation service: the single writer of observations and the hub between simulator and graph.

PRD §7.5 update rules are implemented in :meth:`InvestigationService.investigate`:
observation node → link to action → mark evidence discovered → create evidence relationships →
re-run contradiction detection → recalculate hypotheses → persist → version bump (UI update).
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field

from paradox.cases.loader import list_case_ids, load_public_case
from paradox.engine import contradictions as contradiction_engine
from paradox.engine import eligibility, termination
from paradox.engine import report as report_builder
from paradox.engine.probability import (
    LikelihoodModel,
    entropy,
    hypothesis_links,
    posterior_sequence,
    score_action,
    support_probability,
)
from paradox.graph.store import GraphStore, fmt_time
from paradox.simulator.simulator import Simulator


class InvestigationError(Exception):
    status_code = 400


class InvalidAction(InvestigationError):
    status_code = 422


class VersionConflict(InvestigationError):
    status_code = 409


class CaseNotStarted(InvestigationError):
    status_code = 404


@dataclass
class Session:
    case_id: str
    session_id: str
    store: GraphStore
    simulator: Simulator = field(repr=False)
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class InvestigationService:
    def __init__(self, graph_prefix: str = "paradox"):
        self.graph_prefix = graph_prefix
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ sessions
    def list_cases(self) -> list[dict]:
        out = []
        for cid in list_case_ids():
            c = load_public_case(cid)
            out.append({
                "id": c.id, "title": c.title, "summary": c.summary.strip(),
                "suspects": [p.name for p in c.people if p.suspect],
                "hypotheses": len(c.hypotheses), "actions": len(c.actions),
                "perturbations": [{"id": p.id, "label": p.label, "description": p.description.strip()}
                                  for p in c.perturbations],
                "variants": ["A", "B"],
            })
        return out

    def start(self, case_id: str, variant: str = "A", mode: str = "scripted", seed: int = 0,
              truth: str | None = None, perturbations: list[str] | None = None) -> dict:
        case = load_public_case(case_id)
        simulator = Simulator(case_id, variant=variant, mode=mode, seed=seed, truth=truth)
        store = GraphStore(case_id, name=f"{self.graph_prefix}_{case_id}")
        session = Session(case_id, uuid.uuid4().hex[:12], store, simulator)
        with session.lock:
            store.seed(case, session.session_id)
            contradiction_engine.detect_and_persist(store)
            model = LikelihoodModel.from_graph(store)
            store.append_belief(0, model.priors, entropy(model.priors), "prior")
            for pid in perturbations or []:
                self._apply_perturbation(session, pid)
            store.update_case(simulation=f"variant {variant} · {mode}" + (f" · seed {seed}" if mode == "sampled" else ""))
        with self._lock:
            self._sessions[case_id] = session
        return {"session_id": session.session_id, "state": self.state(case_id),
                "actions": self.evaluate(case_id)["candidates"]}

    def session(self, case_id: str) -> Session:
        with self._lock:
            s = self._sessions.get(case_id)
        if s is None:
            raise CaseNotStarted(f"case '{case_id}' has no active investigation; POST /cases/{case_id}/start")
        return s

    # ------------------------------------------------------------------ reads
    def _posterior(self, store: GraphStore, model: LikelihoodModel | None = None) -> tuple[dict, dict]:
        model = model or LikelihoodModel.from_graph(store)
        obs = store.observations()
        seq = posterior_sequence(model, [(o["action_id"], o["outcome_code"]) for o in obs])
        observed = {o["action_id"]: o["outcome_code"] for o in obs}
        return seq[-1], observed

    def evaluate(self, case_id: str) -> dict:
        s = self.session(case_id)
        with s.lock:
            store = s.store
            model = LikelihoodModel.from_graph(store)
            belief, observed = self._posterior(store, model)
            outcomes = store.outcome_classes()
            candidates = []
            contradictions = store.contradictions()
            case = store.case()
            leader = max(sorted(belief), key=lambda h: belief[h])
            counted = termination.supporting_bundles(store, leader, contradictions)["counted"]
            phase = ("corroborate" if belief[leader] >= case["confidence_threshold"]
                     and len(counted) < case["min_supporting_bundles"] else "discriminate")
            for a in eligibility.evaluate(store):
                entry = {
                    "action_id": a["id"], "label": a["label"], "type": a["type"], "description": a["description"],
                    "cost": a["cost"], "bundle": a["bundle"], "activity": a["activity"],
                    "target": a["target_name"], "evidence_source": a["evidence_name"],
                    "location": a["location_name"], "distance_from_scene": a["distance_from_scene"],
                    "prerequisites": a["prerequisites"], "result_categories": outcomes.get(a["id"], []),
                    "executed": a["executed"], "eligible": a["eligible"],
                    "ineligible_reasons": a["ineligible_reasons"], "eig": 0.0, "p_new_support": 0.0,
                    "utility": 0.0, "outcome_predictions": [], "conditioned_on": {},
                }
                if not a["executed"]:
                    sc = score_action(model, belief, a["id"], a["cost"], observed)
                    p_support = 0.0 if a["bundle"] in counted else support_probability(
                        model, belief, a["id"], leader, observed)
                    utility = sc.utility if phase == "discriminate" else p_support / a["cost"]
                    entry.update(eig=sc.eig, p_new_support=p_support, utility=utility,
                                 outcome_predictions=sc.outcome_predictions, conditioned_on=sc.conditioned_on)
                candidates.append(entry)
            ranked = sorted((c for c in candidates if c["eligible"]), key=lambda c: (-c["utility"], c["action_id"]))
            for i, c in enumerate(ranked):
                c["rank"] = i + 1
            assessment = termination.assess(store, belief, candidates, contradictions, phase)
            objective = ("utility = EIG(a) / cost(a); EIG in bits" if phase == "discriminate" else
                         f"utility = P(outcome adds an independent bundle supporting {leader}) / cost(a)")
            return {
                "belief": belief, "entropy": entropy(belief), "ranked": [c["action_id"] for c in ranked],
                "candidates": candidates, "assessment": assessment, "phase": phase, "objective": objective,
            }

    def state(self, case_id: str) -> dict:
        s = self.session(case_id)
        with s.lock:
            store = s.store
            case = store.case()
            hyps = store.hypotheses()
            obs = store.observations()
            statements = store.query(
                """
                MATCH (p:Person)-[:MADE]->(s:Statement)
                RETURN s.id AS id, p.id AS speaker_id, p.name AS speaker, s.content AS content,
                       s.claim_type AS claim_type, s.source AS source, s.recorded_at AS recorded_at,
                       s.revision AS revision
                ORDER BY s.recorded_at, s.id
                """
            )
            evidence = store.query(
                """
                MATCH (e:Evidence) WHERE e.discovered = true
                OPTIONAL MATCH (o:Observation)-[:REVEALS]->(e)
                RETURN e.id AS id, e.evidence_type AS type, e.name AS name, e.description AS description,
                       e.reliability AS reliability, e.provenance AS provenance, e.bundle AS bundle,
                       o.id AS observation_id
                ORDER BY o.seq, e.id
                """
            )
            people = store.query(
                """
                MATCH (p:Person) OPTIONAL MATCH (p)-[:HAS_ACCESS_TO]->(l:Location)
                RETURN p.id AS id, p.name AS name, p.role AS role, p.suspect AS suspect, p.bio AS bio,
                       collect(l.name) AS access ORDER BY p.suspect DESC, p.id
                """
            )
            return {
                "case_id": case_id, "session_id": case["session_id"], "title": case["title"],
                "summary": case["summary"], "status": case["status"], "status_reason": case["status_reason"],
                "graph_version": case["version"], "budget": case["budget"], "spent": case["spent"],
                "remaining_budget": case["budget"] - case["spent"], "actions_taken": case["actions_taken"],
                "max_actions": case["max_actions"], "confidence_threshold": case["confidence_threshold"],
                "min_supporting_bundles": case["min_supporting_bundles"],
                "window": f"{fmt_time(case['window_start'])}–{fmt_time(case['window_end'])}",
                "simulation": case.get("simulation", ""),
                "perturbations": json.loads(case["perturbations"]),
                "people": people, "hypotheses": hyps, "statements": statements, "evidence": evidence,
                "observations": obs, "contradictions": store.contradictions(),
                "belief_history": store.belief_history(), "decisions": store.decisions(),
            }

    def graph(self, case_id: str) -> dict:
        s = self.session(case_id)
        with s.lock:
            g = s.store.visible_graph()
            g["graph_version"] = s.store.case()["version"]
            return g

    # ------------------------------------------------------------------ writes
    def investigate(self, case_id: str, action_id: str, expected_graph_version: int | None = None) -> dict:
        s = self.session(case_id)
        with s.lock:
            store = s.store
            case = store.case()
            if expected_graph_version is not None and expected_graph_version != case["version"]:
                raise VersionConflict(f"graph version is {case['version']}, expected {expected_graph_version}")
            prior_obs = {o["action_id"]: o for o in store.observations()}
            if action_id in prior_obs:
                # Idempotent: no new outcome, no budget charge.
                o = prior_obs[action_id]
                return {"charged": False, "already_executed": True, "observation": o,
                        "graph_version": case["version"], "remaining_budget": case["budget"] - case["spent"]}
            elig = {a["id"]: a for a in eligibility.evaluate(store)}
            if action_id not in elig:
                raise InvalidAction(f"unknown action '{action_id}'")
            if not elig[action_id]["eligible"]:
                raise InvalidAction(f"action '{action_id}' is not eligible: " + "; ".join(elig[action_id]["ineligible_reasons"]))
            action = elig[action_id]

            model = LikelihoodModel.from_graph(store)
            belief_before, observed = self._posterior(store, model)
            code, reveal = s.simulator.reveal(action_id, observed)
            outcome_label = next(o["label"] for o in store.outcome_classes()[action_id] if o["code"] == code)
            seq = case["actions_taken"] + 1
            discovered_at = case["incident_time"] + 10 * seq
            obs_id = store.record_observation(
                seq=seq, action_id=action_id, outcome_code=code, outcome_label=outcome_label,
                evidence_id=action["evidence_id"], description=reveal.description,
                reliability=reveal.reliability, provenance=reveal.provenance, bundle=action["bundle"],
                records=reveal.records, assertions=reveal.assertions,
                statements=[st.model_dump() for st in reveal.statements],
                explains=[e.model_dump() for e in reveal.explains], discovered_at=discovered_at,
            )
            store.write_hypothesis_links(action["evidence_id"], hypothesis_links(model, action_id, code, observed))
            before_ids = {k["id"] for k in store.contradictions()}
            contradictions = contradiction_engine.detect_and_persist(store)
            belief_after, _ = self._posterior(store, model)
            store.set_posteriors(belief_after)
            store.append_belief(seq, belief_after, entropy(belief_after), obs_id)
            store.update_case(spent=case["spent"] + action["cost"], actions_taken=seq)
            version = store.bump_version()

            evaluation = self.evaluate(case_id)
            assessment = evaluation["assessment"]
            if assessment["stop"] and assessment["outcome"] == "inconclusive" and not any(
                c["eligible"] for c in evaluation["candidates"]
            ):
                # Hard limits close the case automatically; confidence-based closure is the agent's call.
                self._close(store, "inconclusive", assessment["reason"])
            new_k = [k for k in contradictions if k["id"] not in before_ids]
            case = store.case()
            return {
                "charged": True, "already_executed": False,
                "observation": {
                    "id": obs_id, "seq": seq, "action_id": action_id, "action_label": action["label"],
                    "outcome_code": code, "outcome_label": outcome_label, "evidence_id": action["evidence_id"],
                    "description": reveal.description, "reliability": reveal.reliability,
                    "provenance": reveal.provenance, "bundle": action["bundle"],
                    "new_statements": [st.id for st in reveal.statements],
                },
                "graph_version": version, "remaining_budget": case["budget"] - case["spent"],
                "hypotheses": {"before": belief_before, "after": belief_after,
                               "caused_by": obs_id},
                "new_contradictions": new_k, "assessment": assessment, "status": case["status"],
                "remaining_actions": [c["action_id"] for c in evaluation["candidates"] if c["eligible"]],
            }

    def conclude(self, case_id: str) -> dict:
        s = self.session(case_id)
        with s.lock:
            assessment = self.evaluate(case_id)["assessment"]
            outcome = "solved" if assessment["outcome"] == "solved" else "inconclusive"
            reason = assessment["reason"] if assessment["stop"] else "closed before stopping criteria were met: " + assessment["reason"]
            self._close(s.store, outcome, reason)
            return {"status": outcome, "reason": reason}

    def _close(self, store: GraphStore, outcome: str, reason: str) -> None:
        store.update_case(status=outcome, status_reason=reason)
        store.bump_version()

    def perturb(self, case_id: str, perturbation_id: str) -> dict:
        s = self.session(case_id)
        with s.lock:
            self._apply_perturbation(s, perturbation_id)
            return {"graph_version": s.store.case()["version"], "applied": perturbation_id}

    def _apply_perturbation(self, s: Session, perturbation_id: str) -> None:
        case = load_public_case(s.case_id)
        p = next((p for p in case.perturbations if p.id == perturbation_id), None)
        if p is None:
            raise InvalidAction(f"unknown perturbation '{perturbation_id}'")
        s.store.apply_perturbation(p)
        contradiction_engine.detect_and_persist(s.store)
        s.store.bump_version()

    def record_decision(self, case_id: str, decision: dict) -> None:
        s = self.session(case_id)
        with s.lock:
            s.store.append_decision(decision)

    def disclose_truth(self, case_id: str) -> dict | None:
        s = self.session(case_id)
        status = s.store.case()["status"]
        if status == "open":
            return None
        return s.simulator.disclose_truth(case_closed=True)

    def report(self, case_id: str, include_truth: bool = True) -> dict:
        s = self.session(case_id)
        with s.lock:
            out = report_builder.build(s.store, self.evaluate(case_id), self.state(case_id))
            if include_truth:
                truth = self.disclose_truth(case_id)
                if truth is None:
                    out["ground_truth"] = {"sealed": True, "note": "Ground truth is revealed once the case is closed."}
                else:
                    out["ground_truth"] = {
                        "sealed": False, **truth,
                        "leading_matches_truth": truth["truth"] == out["leading_hypothesis"],
                        "correct_solve": out["outcome"] == "solved" and truth["truth"] == out["leading_hypothesis"],
                    }
            return out
