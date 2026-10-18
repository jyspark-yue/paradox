"""Graph-backed action eligibility (PRD §8.6)."""

from __future__ import annotations

from paradox.graph.store import GraphStore


def evaluate(store: GraphStore) -> list[dict]:
    case = store.case()
    remaining = case["budget"] - case["spent"]
    requirements = store.action_requirements()
    distances = store.distance_from_crime_scene()
    contradicted = store.contradicted_people()
    out = []
    for a in store.actions():
        reasons = []
        if a["executed"]:
            reasons.append("already executed")
        if case["status"] != "open":
            reasons.append(f"case is {case['status']}")
        if case["actions_taken"] >= case["max_actions"]:
            reasons.append("maximum action count reached")
        unmet = [r["label"] for r in requirements.get(a["id"], []) if not r["executed"]]
        if unmet:
            reasons.append("requires: " + ", ".join(unmet))
        if a["evidence_id"] and a["evidence_accessible"] is False:
            reasons.append("evidence no longer accessible")
        if a["location_id"]:
            dist = distances.get(a["location_id"])
            if dist is None or dist > case["relevance_minutes"]:
                where = "unreachable" if dist is None else f"{dist} min away"
                reasons.append(
                    f"{a['location_name']} is {where} from the crime scene "
                    f"(relevance radius {case['relevance_minutes']} min)"
                )
        if a["requires_contradiction_on"] and a["requires_contradiction_on"] not in contradicted:
            reasons.append(f"needs a recorded contradiction involving {a['target_name']}")
        if a["cost"] > remaining:
            reasons.append(f"cost {a['cost']} exceeds remaining budget {remaining}")
        out.append({
            **a,
            "eligible": not reasons,
            "ineligible_reasons": reasons,
            "prerequisites": [r["required"] for r in requirements.get(a["id"], [])],
            "distance_from_scene": distances.get(a["location_id"]) if a["location_id"] else None,
        })
    return out
