"""The detective agent's tool surface (PRD §10).

These are the only operations an agent — deterministic planner, LLM, or MCP client — can perform.
Every tool takes strictly validated arguments, reads FalkorDB through fixed Cypher templates,
and never touches simulator-private state. Case content (statements, evidence descriptions) is
returned inside ``untrusted_case_content`` fields so it is treated as testimony, not instructions.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from paradox.graph.db import GraphUnavailableError
from paradox.service import InvestigationError, InvestigationService

RelationshipType = Literal["claims", "records", "contradictions", "evidence_for_hypothesis", "neighborhood"]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_id: str = Field(pattern=r"^case\d{3}$")


class CaseArgs(_Args):
    pass


class QueryRelationshipsArgs(_Args):
    entity_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_:\-]+$")
    relationship_type: RelationshipType
    max_depth: int = Field(default=3, ge=1, le=3)


class ExecuteArgs(_Args):
    action_id: str = Field(pattern=r"^act_[a-z0-9_]+$")


class ToolError(Exception):
    pass


# Predefined traversal templates — no generated Cypher reaches the database.
_TEMPLATES: dict[str, str] = {
    "claims": """
        MATCH path = (p:Person {id: $id})-[:MADE]->(s:Statement)-[:ABOUT]->(ev:Event)
        OPTIONAL MATCH (ev)-[:OCCURRED_AT]->(loc:Location)
        RETURN s.id AS statement_id, s.content AS statement, s.claim_type AS claim_type,
               ev.id AS event_id, ev.description AS event, ev.status AS event_status, loc.name AS location,
               [n IN nodes(path) | n.id] + CASE WHEN loc IS NULL THEN [] ELSE [loc.id] END AS path
        ORDER BY s.id, ev.id
    """,
    "records": """
        MATCH path = (e:Evidence)-[:RECORDS]->(ev:Event)-[:PLACES]->(p:Person {id: $id})
        WHERE e.discovered = true
        OPTIONAL MATCH (ev)-[:OCCURRED_AT]->(loc:Location)
        RETURN e.id AS evidence_id, e.name AS source, e.reliability AS reliability, ev.id AS event_id,
               ev.description AS event, loc.name AS location,
               [n IN nodes(path) | n.id] AS path
        ORDER BY ev.time_start
    """,
    "contradictions": """
        MATCH path = (p:Person {id: $id})-[:MADE]->(s:Statement)<-[:INVOLVES]-(k:Contradiction)
        OPTIONAL MATCH (k)-[:INVOLVES]->(e:Evidence)
        RETURN k.id AS contradiction_id, k.contradiction_type AS type, k.status AS status,
               k.description AS description, s.id AS statement_id, collect(DISTINCT e.id) AS evidence_ids,
               [n IN nodes(path) | n.id] AS path
        ORDER BY k.id
    """,
    "evidence_for_hypothesis": """
        MATCH path = (a:InvestigationAction)<-[:RESULT_OF]-(o:Observation)-[:REVEALS]->(e:Evidence)
                     -[r:SUPPORTS|CHALLENGES]->(h:Hypothesis {id: $id})
        RETURN e.id AS evidence_id, type(r) AS relation, r.weight AS likelihood_ratio, e.bundle AS bundle,
               e.description AS evidence, a.id AS action_id, [n IN nodes(path) | n.id] AS path
        ORDER BY o.seq
    """,
}

_NEIGHBORHOOD = """
    MATCH path = (n {{id: $id}})-[*1..{depth}]-(m)
    WHERE NONE(x IN nodes(path) WHERE x:OutcomeClass OR x:BeliefState OR x:Decision OR x:Case)
    RETURN DISTINCT m.id AS entity_id, labels(m)[0] AS entity_type, length(path) AS hops,
           [x IN nodes(path) | x.id] AS path, [r IN relationships(path) | type(r)] AS relationships
    ORDER BY hops, entity_id
    LIMIT 80
"""


class DetectiveTools:
    """Agent-facing tool facade. Holds a service reference but exposes no truth-bearing method."""

    def __init__(self, service: InvestigationService):
        self._service = service

    # 10.1
    def get_case_state(self, case_id: str) -> dict:
        st = self._service.state(case_id)
        return {
            "case_id": case_id, "title": st["title"], "status": st["status"],
            "graph_version": st["graph_version"], "remaining_budget": st["remaining_budget"],
            "budget": st["budget"], "actions_taken": st["actions_taken"], "max_actions": st["max_actions"],
            "people": [{"id": p["id"], "name": p["name"], "role": p["role"], "suspect": p["suspect"]} for p in st["people"]],
            "hypotheses": [{"id": h["id"], "description": h["description"], "person_id": h["person_id"],
                            "posterior": h["posterior"]} for h in st["hypotheses"]],
            "untrusted_case_content": {
                "summary": st["summary"],
                "statements": [{"id": s["id"], "speaker_id": s["speaker_id"], "content": s["content"],
                                "claim_type": s["claim_type"]} for s in st["statements"]],
                "discovered_evidence": [{"id": e["id"], "type": e["type"], "description": e["description"],
                                         "reliability": e["reliability"]} for e in st["evidence"]],
            },
            "investigation_progress": [{"seq": o["seq"], "action_id": o["action_id"], "outcome": o["outcome_code"],
                                        "evidence_id": o["evidence_id"]} for o in st["observations"]],
        }

    # 10.2
    def query_relationships(self, case_id: str, entity_id: str, relationship_type: str, max_depth: int = 3) -> dict:
        store = self._service.session(case_id).store
        if relationship_type == "neighborhood":
            rows = store.query(_NEIGHBORHOOD.format(depth=int(max_depth)), {"id": entity_id})
        else:
            rows = store.query(_TEMPLATES[relationship_type], {"id": entity_id})
        evidence_ids = sorted({
            x for r in rows for x in (r.get("path") or []) + (r.get("evidence_ids") or [])
            if isinstance(x, str) and (x.startswith("src_") or x.startswith("ev_"))
        })
        return {"entity_id": entity_id, "relationship_type": relationship_type, "max_depth": max_depth,
                "count": len(rows), "untrusted_case_content": rows, "evidence_ids": evidence_ids}

    # 10.3
    def detect_contradictions(self, case_id: str) -> dict:
        ks = self._service.state(case_id)["contradictions"]
        return {
            "count": len(ks),
            "contradictions": [
                {"id": k["id"], "classification": k["type"], "rule": k["rule"], "status": k["status"],
                 "status_reason": k["status_reason"], "subject_id": k["subject_id"],
                 "statement_ids": k["statement_ids"], "evidence_ids": k["evidence_ids"],
                 "graph_path_refs": k["event_ids"], "untrusted_case_content": k["description"]}
                for k in ks
            ],
            "note": "A contradiction flags conflicting claims; it is not proof of deception.",
        }

    # 10.4
    def list_available_actions(self, case_id: str) -> dict:
        ev = self._service.evaluate(case_id)
        return {
            "remaining_budget": ev["assessment"]["remaining_budget"],
            "actions": [
                {"action_id": c["action_id"], "label": c["label"], "type": c["type"], "cost": c["cost"],
                 "target": c["target"], "prerequisites": c["prerequisites"], "eligible": c["eligible"],
                 "ineligible_reasons": c["ineligible_reasons"],
                 "result_categories": [o["label"] for o in c["result_categories"]]}
                for c in ev["candidates"] if not c["executed"]
            ],
        }

    # 10.5
    def evaluate_investigations(self, case_id: str) -> dict:
        ev = self._service.evaluate(case_id)
        cands = {c["action_id"]: c for c in ev["candidates"]}
        a = ev["assessment"]
        return {
            "objective": ev["objective"], "phase": ev["phase"], "current_entropy_bits": ev["entropy"],
            "candidates": [
                {"rank": cands[aid]["rank"], "action_id": aid, "label": cands[aid]["label"],
                 "expected_information_gain": round(cands[aid]["eig"], 4),
                 "p_new_independent_support": round(cands[aid]["p_new_support"], 4), "cost": cands[aid]["cost"],
                 "utility": round(cands[aid]["utility"], 4), "conditioned_on": cands[aid]["conditioned_on"],
                 "predicted_outcomes": [{"code": p["code"], "probability": round(p["probability"], 3)}
                                        for p in cands[aid]["outcome_predictions"]]}
                for aid in ev["ranked"]
            ],
            "stopping_assessment": {"should_stop": a["stop"], "outcome": a["outcome"], "reason": a["reason"],
                                    "leader": a["leader"], "confidence": a["confidence"],
                                    "supporting_bundles": a["supporting_bundles"]},
            "constraints": "Outcome probabilities are model predictions; the actual result is unknown until executed.",
        }

    # 10.6
    def execute_investigation(self, case_id: str, action_id: str) -> dict:
        r = self._service.investigate(case_id, action_id)
        obs = r["observation"]
        return {
            "charged": r["charged"], "already_executed": r["already_executed"],
            "observation": {"id": obs["id"], "seq": obs["seq"], "action_id": obs["action_id"],
                            "outcome_code": obs["outcome_code"], "outcome_label": obs.get("outcome_label"),
                            "evidence_id": obs["evidence_id"],
                            "untrusted_case_content": obs.get("description") or obs.get("evidence_description")},
            "discovered_evidence_ids": [obs["evidence_id"]] + obs.get("new_statements", []),
            "graph_version": r["graph_version"], "remaining_budget": r["remaining_budget"],
        }

    # 10.7
    def update_hypotheses(self, case_id: str) -> dict:
        st = self._service.state(case_id)
        hist = st["belief_history"]
        prev = hist[-2] if len(hist) > 1 else hist[-1]
        last = hist[-1]
        return {
            "prior": prev["probs"], "posterior": last["probs"], "caused_by_observation": last["cause"],
            "entropy_bits": last["entropy"],
            "model_assumptions": [
                "Exactly one listed hypothesis is true (mutually exclusive, exhaustive).",
                "Priors are uniform — an MVP assumption.",
                "Likelihoods come from the case's explicit tables stored on OutcomeClass-[:LIKELIHOOD]->Hypothesis edges.",
                "Correlated observations use conditional tables keyed on earlier outcomes instead of independence.",
            ],
        }

    # 10.8
    def generate_case_report(self, case_id: str) -> dict:
        r = self._service.report(case_id, include_truth=False)
        r.pop("ground_truth", None)
        return r

    # ------------------------------------------------------------------ dispatch
    _SPECS: dict[str, type[_Args]] = {
        "get_case_state": CaseArgs,
        "query_relationships": QueryRelationshipsArgs,
        "detect_contradictions": CaseArgs,
        "list_available_actions": CaseArgs,
        "evaluate_investigations": CaseArgs,
        "execute_investigation": ExecuteArgs,
        "update_hypotheses": CaseArgs,
        "generate_case_report": CaseArgs,
    }

    def call(self, name: str, args: dict[str, Any]) -> dict:
        spec = self._SPECS.get(name)
        if spec is None:
            raise ToolError(f"unknown tool '{name}'")
        try:
            parsed = spec.model_validate(args)
        except ValidationError as exc:
            raise ToolError(f"invalid arguments for {name}: {exc.errors(include_url=False)}") from exc
        try:
            return getattr(self, name)(**parsed.model_dump())
        except GraphUnavailableError as exc:
            raise ToolError(f"graph store unavailable: {exc}") from exc
        except InvestigationError as exc:
            raise ToolError(str(exc)) from exc


TOOL_DESCRIPTIONS = {
    "get_case_state": "Current known facts, discovered evidence, hypotheses with posteriors, remaining budget and progress.",
    "query_relationships": (
        "Traverse the case graph from an entity using a predefined template: 'claims' (Person→Statement→Event→Location), "
        "'records' (Evidence→Event→Person), 'contradictions' (Person→Statement←Contradiction), "
        "'evidence_for_hypothesis' (Action←Observation→Evidence→Hypothesis), or 'neighborhood' (any relationships, up to max_depth hops)."
    ),
    "detect_contradictions": "Conflicting claims found by deterministic temporal/logical rules, with their classification, status and graph references.",
    "list_available_actions": "Investigative actions with costs, targets, prerequisites, eligibility and possible result categories (never the actual result).",
    "evaluate_investigations": "Rank eligible actions by utility = expected information gain / cost, plus the stopping assessment.",
    "execute_investigation": "Execute one eligible action. Reveals a simulated observation, updates the graph and charges the budget. Idempotent.",
    "update_hypotheses": "Prior and posterior hypothesis probabilities around the latest observation, and the model assumptions.",
    "generate_case_report": "Structured case report: conclusion or inconclusive outcome, confidence, evidence paths, contradictions, history.",
}


def anthropic_tool_definitions() -> list[dict]:
    defs = []
    for name, spec in DetectiveTools._SPECS.items():
        schema = spec.model_json_schema()
        schema.pop("title", None)
        for prop in schema.get("properties", {}).values():
            # Constraints are enforced by Pydantic on our side; keep the wire schema to the strict-mode subset.
            for key in ("title", "pattern", "minLength", "maxLength", "minimum", "maximum", "default"):
                prop.pop(key, None)
        schema["additionalProperties"] = False
        schema["required"] = list(schema.get("properties", {}))
        defs.append({"name": name, "description": TOOL_DESCRIPTIONS[name], "input_schema": schema, "strict": True})
    return defs
