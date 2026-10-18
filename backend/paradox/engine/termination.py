"""Stopping rules and evidence sufficiency (PRD §8.8)."""

from __future__ import annotations

from paradox.engine.contradictions import undermined_evidence
from paradox.graph.store import GraphStore

# Evaluation switch (RQ3): when False, evidence undermined by contradictions still counts toward sufficiency.
CONTRADICTION_AWARE = True


def supporting_bundles(store: GraphStore, hypothesis: str, contradictions: list[dict]) -> dict:
    """Distinct evidence bundles that support ``hypothesis`` and are not undermined by a contradiction."""
    doubtful = undermined_evidence(contradictions) if CONTRADICTION_AWARE else set()
    counted: dict[str, list[str]] = {}
    discounted: dict[str, list[str]] = {}
    for link in store.evidence_links():
        if link["hypothesis"] != hypothesis or link["kind"] != "SUPPORTS":
            continue
        target = discounted if link["evidence_id"] in doubtful else counted
        target.setdefault(link["bundle"], []).append(link["evidence_id"])
    return {"counted": counted, "discounted": discounted}


MIN_SUPPORT_PROBABILITY = 0.05


def assess(store: GraphStore, posterior: dict[str, float], scores: list[dict], contradictions: list[dict],
           phase: str = "discriminate") -> dict:
    case = store.case()
    leader = max(sorted(posterior), key=lambda h: posterior[h])
    confidence = posterior[leader]
    bundles = supporting_bundles(store, leader, contradictions)
    n_bundles = len(bundles["counted"])
    sufficient = n_bundles >= case["min_supporting_bundles"]
    eligible = [s for s in scores if s["eligible"]]
    best_eig = max((s["eig"] for s in eligible), default=0.0)
    best_support = max((s.get("p_new_support", 0.0) for s in eligible), default=0.0)
    remaining = case["budget"] - case["spent"]

    base = {"leader": leader, "confidence": confidence, "supporting_bundles": n_bundles,
            "bundles": bundles, "best_eig": best_eig, "best_support_probability": best_support,
            "phase": phase, "remaining_budget": remaining}
    if confidence >= case["confidence_threshold"] and sufficient:
        return {**base, "stop": True, "outcome": "solved",
                "reason": f"{leader} at {confidence:.1%} ≥ {case['confidence_threshold']:.0%} with "
                          f"{n_bundles} independent supporting evidence bundles"}
    if case["actions_taken"] >= case["max_actions"]:
        return {**base, "stop": True, "outcome": "inconclusive", "reason": "maximum action count reached"}
    if not eligible:
        reason = "investigation budget exhausted" if remaining <= 0 or all(
            s["cost"] > remaining for s in scores if not s["executed"]) else "no eligible action remains"
        return {**base, "stop": True, "outcome": "inconclusive", "reason": reason}
    if phase == "corroborate":
        if best_support < MIN_SUPPORT_PROBABILITY:
            return {**base, "stop": True, "outcome": "inconclusive",
                    "reason": f"{leader} leads at {confidence:.1%} but no remaining action is likely to add "
                              f"independent support (best {best_support:.1%})"}
    elif best_eig < case["negligible_eig"]:
        return {**base, "stop": True, "outcome": "inconclusive",
                "reason": f"remaining actions have negligible expected information gain ({best_eig:.4f} bits)"}
    why = []
    if confidence < case["confidence_threshold"]:
        why.append(f"confidence {confidence:.1%} below {case['confidence_threshold']:.0%}")
    if not sufficient:
        why.append(f"only {n_bundles}/{case['min_supporting_bundles']} independent supporting bundles")
    return {**base, "stop": False, "outcome": None, "reason": "; ".join(why)}
