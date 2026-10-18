"""Deterministic contradiction detection over structured claims in the graph.

Rules (PRD §8.7):
  A  conflicting location claims   — two statements place a person in incompatible places
  B  statement versus record       — a recorded event conflicts with a statement
  C  directly incompatible claims  — two statements assert opposite predicates for the same window
  D  evidence inconsistency        — two records conflict and neither is established as authoritative

Two placements of the same person conflict when the locations differ and the gap between the
intervals is shorter than the shortest walking time between the locations (graph traversal over
CONNECTED_TO). A contradiction is a flagged conflict, never proof that anyone lied.
"""

from __future__ import annotations

import hashlib
from itertools import combinations

from paradox.graph.store import GraphStore, fmt_time

AUTHORITATIVE_RELIABILITY = 0.8

TYPE_NAMES = {
    "A": "conflicting_location_claims",
    "B": "statement_vs_record",
    "C": "incompatible_claims",
    "D": "evidence_inconsistency",
}


def _gap(a: dict, b: dict) -> int:
    return max(0, max(a["start"], b["start"]) - min(a["end"], b["end"]))


def _overlap(a: dict, b: dict) -> bool:
    return max(a["start"], b["start"]) <= min(a["end"], b["end"])


def _source(ev: dict) -> str:
    return ev["statement_id"] or ev["evidence_id"]


def _describe_source(ev: dict) -> str:
    if ev["status"] == "alleged":
        return f"{ev['speaker_name']}'s statement ({ev['statement_id']})"
    return f"the {ev['evidence_name']} ({ev['evidence_id']})"


def _describe_claim(ev: dict) -> str:
    span = f"{fmt_time(ev['start'])}–{fmt_time(ev['end'])}"
    if ev["kind"] == "placement":
        return f"at {ev['location_name']} {span}"
    neg = "" if ev["value"] else "not "
    return f"{neg}{ev['predicate'].replace('_', ' ')} {span}"


def detect(store: GraphStore) -> tuple[list[dict], list[dict]]:
    events = store.claim_events()
    travel = store.travel_minutes()

    raw: list[dict] = []
    corroborations: list[dict] = []
    by_subject: dict[str, list[dict]] = {}
    for ev in events:
        by_subject.setdefault(ev["subject"], []).append(ev)

    for subject, evs in by_subject.items():
        for x, y in combinations(evs, 2):
            if _source(x) == _source(y) or x["kind"] != y["kind"]:
                continue
            if x["kind"] == "placement":
                if x["location"] == y["location"]:
                    if _overlap(x, y) and {x["status"], y["status"]} == {"alleged", "recorded"}:
                        rec, st = (x, y) if x["status"] == "recorded" else (y, x)
                        corroborations.append({"evidence": rec["evidence_id"], "statement": st["statement_id"],
                                               "confidence": rec["reliability"], "event": rec["id"]})
                    continue
                minutes = travel.get((x["location"], y["location"]))
                gap = _gap(x, y)
                if minutes is not None and gap >= minutes:
                    continue
                detail = (f"shortest route is {minutes} min but only {gap} min separate them"
                          if minutes is not None else "no route connects the two locations")
            else:
                if x["predicate"] != y["predicate"] or not _overlap(x, y):
                    continue
                if x["value"] == y["value"]:
                    if {x["status"], y["status"]} == {"alleged", "recorded"}:
                        rec, st = (x, y) if x["status"] == "recorded" else (y, x)
                        corroborations.append({"evidence": rec["evidence_id"], "statement": st["statement_id"],
                                               "confidence": rec["reliability"], "event": rec["id"]})
                    continue
                minutes, gap = None, 0
                detail = "the claims assert opposite facts for overlapping times"

            statuses = {x["status"], y["status"]}
            if statuses == {"alleged"}:
                rule = "A" if x["kind"] == "placement" else "C"
            elif statuses == {"recorded"}:
                rule = "D"
            else:
                rule = "B"
                if x["status"] == "recorded":  # canonical order: statement first, record second
                    x, y = y, x
            raw.append({
                "rule": rule, "x": x, "y": y, "subject": subject, "travel_minutes": minutes,
                "gap_minutes": gap,
                "description": (
                    f"{_describe_source(x)} puts {x['subject_name']} {_describe_claim(x)}, but "
                    f"{_describe_source(y)} puts them {_describe_claim(y)}; {detail}."
                ),
            })

    corroborated: dict[str, float] = {}
    for c in corroborations:
        corroborated[c["statement"]] = max(corroborated.get(c["statement"], 0.0), c["confidence"] or 0.0)
    # Record-vs-record conflicts, used to decide whether a statement's corroboration actually
    # contests the same moment as the record that contradicts it.
    record_conflicts = {frozenset((k["x"]["id"], k["y"]["id"])) for k in raw if k["rule"] == "D"}
    rel_by_event = {ev["id"]: ev["reliability"] or 0.0 for ev in events if ev["status"] == "recorded"}
    contesting: dict[str, float] = {}
    for k in raw:
        if k["rule"] != "B":
            continue
        for c in corroborations:
            if c["statement"] == k["x"]["statement_id"] and frozenset((c["event"], k["y"]["id"])) in record_conflicts:
                contesting[k["y"]["id"]] = max(contesting.get(k["y"]["id"], 0.0), rel_by_event.get(c["event"], 0.0))
    contradicted_by_record: dict[str, float] = {}
    for k in raw:
        if k["rule"] == "B":
            sid = k["x"]["statement_id"]
            contradicted_by_record[sid] = max(contradicted_by_record.get(sid, 0.0), k["y"]["reliability"] or 0.0)

    contradictions = []
    for k in raw:
        x, y = k["x"], k["y"]
        status, reason = _status(k, corroborated, contradicted_by_record, contesting)
        event_ids = [x["id"], y["id"]]
        statement_ids = [e["statement_id"] for e in (x, y) if e["statement_id"]]
        evidence_ids = [e["evidence_id"] for e in (x, y) if e["evidence_id"]]
        evidence_ids += [e["statement_evidence"] for e in (x, y) if e["statement_evidence"]]
        cid = "K-" + hashlib.sha1("|".join(sorted(event_ids)).encode()).hexdigest()[:8]
        contradictions.append({
            "id": cid, "rule": k["rule"], "type": TYPE_NAMES[k["rule"]], "subject": k["subject"],
            "description": k["description"], "status": status, "status_reason": reason,
            "event_ids": event_ids, "statement_ids": statement_ids, "evidence_ids": sorted(set(evidence_ids)),
            "travel_minutes": k["travel_minutes"] if k["travel_minutes"] is not None else -1,
            "gap_minutes": k["gap_minutes"], "confidence": (y.get("reliability") or 0.0),
            "explained_evidence": next((e["evidence_id"] or e["statement_evidence"] or ""
                                        for e in (x, y) if e["explained_by"]), ""),
            "losing_evidence": (y["evidence_id"] or "") if status == "refuted" else "",
        })
    contradictions.sort(key=lambda c: c["id"])
    return contradictions, corroborations


def _status(k: dict, corroborated: dict[str, float], contradicted_by_record: dict[str, float],
            contesting: dict[str, float]) -> tuple[str, str]:
    x, y = k["x"], k["y"]
    explained = [e for e in (x, y) if e["explained_by"]]
    if explained:
        return "explained", f"{', '.join(explained[0]['explained_by'])} offers an innocent explanation for one side"
    if k["rule"] == "B":
        statement, record = x, y
        if contesting.get(record["id"], 0.0) > (record["reliability"] or 0.0):
            return "refuted", "a more reliable record corroborates the statement for the same moment"
        if (record["reliability"] or 0.0) >= AUTHORITATIVE_RELIABILITY:
            return "supported", f"record reliability {record['reliability']:.2f} meets the authority threshold"
        return "unresolved", "the record is not reliable enough to settle the conflict"
    if k["rule"] in ("A", "C"):
        for side, other in ((x, y), (y, x)):
            if contradicted_by_record.get(side["statement_id"], 0.0) >= AUTHORITATIVE_RELIABILITY:
                return "supported", f"{side['statement_id']} is independently contradicted by an authoritative record"
            if corroborated.get(side["statement_id"], 0.0) >= AUTHORITATIVE_RELIABILITY:
                return "supported", f"{side['statement_id']} is corroborated by an authoritative record"
        return "unresolved", "testimony against testimony; no record settles it"
    return "unresolved", "two records disagree and neither is established as more authoritative"


def undermined_evidence(contradictions: list[dict]) -> set[str]:
    """Evidence whose evidential weight is in doubt because of an open, explained or refuted conflict."""
    out: set[str] = set()
    for k in contradictions:
        if k["status"] == "unresolved":
            out.update(k["evidence_ids"])
        elif k["status"] == "explained" and k.get("explained_evidence"):
            out.add(k["explained_evidence"])
        elif k["status"] == "refuted" and k.get("losing_evidence"):
            out.add(k["losing_evidence"])
    return out


def detect_and_persist(store: GraphStore) -> list[dict]:
    contradictions, corroborations = detect(store)
    store.replace_contradictions(contradictions, corroborations)
    return contradictions
