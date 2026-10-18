"""Structured, evidence-grounded case report (PRD §5.3, FR-07)."""

from __future__ import annotations

from paradox.graph.store import GraphStore


def evidence_paths(store: GraphStore, hypothesis: str) -> list[dict]:
    rows = store.query(
        """
        MATCH path = (a:InvestigationAction)<-[:RESULT_OF]-(o:Observation)-[:REVEALS]->(e:Evidence)
                     -[r:SUPPORTS]->(h:Hypothesis {id: $h})-[:IMPLICATES]->(p:Person)
        RETURN [n IN nodes(path) | n.id] AS path, a.label AS action, e.description AS evidence,
               e.bundle AS bundle, e.reliability AS reliability, r.weight AS likelihood_ratio, o.seq AS seq
        ORDER BY o.seq
        """,
        {"h": hypothesis},
    )
    return rows


def statement_conflict_paths(store: GraphStore, person_id: str) -> list[dict]:
    return store.query(
        """
        MATCH path = (p:Person {id: $p})-[:MADE]->(s:Statement)<-[c:CONTRADICTS]-(e:Evidence)
        WHERE e.discovered = true
        RETURN [n IN nodes(path) | n.id] AS path, s.content AS statement, e.description AS evidence,
               c.contradiction_id AS contradiction_id
        """,
        {"p": person_id},
    )


def build(store: GraphStore, evaluation: dict, state: dict) -> dict:
    belief = evaluation["belief"]
    assessment = evaluation["assessment"]
    ranking = sorted(state["hypotheses"], key=lambda h: -belief[h["id"]])
    leader = ranking[0]
    solved = state["status"] == "solved" or (state["status"] == "open" and assessment["outcome"] == "solved")
    contradictions = state["contradictions"]
    open_issues = [k for k in contradictions if k["status"] == "unresolved"]
    unexplored = sorted(
        (c for c in evaluation["candidates"] if c["eligible"]), key=lambda c: -c["eig"]
    )[:3]
    obs = state["observations"]
    history = []
    beliefs = {b["seq"]: b["probs"] for b in state["belief_history"]}
    decisions = {d["seq"]: d for d in state["decisions"]}
    for o in obs:
        d = decisions.get(o["seq"], {})
        history.append({
            "seq": o["seq"], "action_id": o["action_id"], "action": o["action_label"], "cost": o["cost"],
            "outcome": o["outcome_label"], "evidence": o["evidence_description"],
            "belief_before": beliefs.get(o["seq"] - 1), "belief_after": beliefs.get(o["seq"]),
            "policy": d.get("policy", "manual"), "rationale": d.get("rationale"),
        })
    if solved:
        conclusion = f"{leader['description']}."
    else:
        conclusion = (f"Inconclusive. Leading explanation: {leader['description']} "
                      f"({belief[leader['id']]:.0%}), which does not meet the stopping criteria.")
    return {
        "case_id": state["case_id"], "title": state["title"], "status": state["status"],
        "outcome": "solved" if solved else "inconclusive",
        "status_reason": state["status_reason"] or assessment["reason"],
        "conclusion": conclusion,
        "leading_hypothesis": leader["id"], "confidence": belief[leader["id"]],
        "confidence_note": "Posterior probability under the case's explicit likelihood model; not a real-world certainty.",
        "suspect_ranking": [
            {"hypothesis": h["id"], "description": h["description"], "person": h["person_name"],
             "probability": belief[h["id"]]} for h in ranking
        ],
        "critical_evidence": evidence_paths(store, leader["id"]),
        "supporting_bundles": assessment["bundles"],
        "contradictions": contradictions,
        "contradiction_paths": statement_conflict_paths(store, leader["person_id"]),
        "investigation_history": history,
        "remaining_uncertainty": {
            "entropy_bits": evaluation["entropy"],
            "runner_up": {"hypothesis": ranking[1]["id"], "probability": belief[ranking[1]["id"]]} if len(ranking) > 1 else None,
            "unresolved_contradictions": [k["description"] for k in open_issues],
            "unexplored_actions": [{"action_id": c["action_id"], "label": c["label"], "eig": c["eig"]} for c in unexplored],
        },
        "total_cost": state["spent"], "budget": state["budget"], "actions_taken": state["actions_taken"],
        "graph_version": state["graph_version"],
    }
