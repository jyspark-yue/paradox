"""Detective agent controller: Observe → Query Graph → Evaluate → Choose → Execute → Update → Repeat.

The controller uses only :class:`DetectiveTools`. Every operation it performs is logged as a
trace entry with an activity label, so the UI shows exactly what actually executed.
"""

from __future__ import annotations

import time
from collections.abc import Iterator

from paradox.agent.planner import make_policy
from paradox.agent.tools import DetectiveTools, ToolError
from paradox.service import InvestigationService


class AgentHalted(Exception):
    """Raised when the agent cannot proceed safely (e.g. the graph store is unavailable)."""


def _pct(p: float) -> str:
    return f"{p:.0%}"


class DetectiveAgent:
    def __init__(self, service: InvestigationService, policy: str = "eig", seed: int = 0):
        self.service = service
        self.tools = DetectiveTools(service)
        self.policy = make_policy(policy, seed)

    def _call(self, trace: list, activity: str, name: str, **args) -> dict:
        t0 = time.perf_counter()
        try:
            out = self.tools.call(name, args)
        except ToolError as exc:
            trace.append({"tool": name, "args": args, "activity": activity, "ok": False, "error": str(exc)})
            if "graph store unavailable" in str(exc):
                raise AgentHalted(f"Refusing to continue: {exc}") from exc
            raise
        trace.append({"tool": name, "args": args, "activity": activity, "ok": True,
                      "ms": round((time.perf_counter() - t0) * 1000, 1)})
        return out

    def step(self, case_id: str) -> dict:
        trace: list[dict] = []
        state = self._call(trace, "Reading the case file", "get_case_state", case_id=case_id)
        if state["status"] != "open":
            return {"done": True, "status": state["status"], "trace": trace, "decision": None}

        names = {p["id"]: p["name"] for p in state["people"]}
        before = self._call(trace, "Checking temporal consistency", "detect_contradictions", case_id=case_id)
        leader = max(state["hypotheses"], key=lambda h: (h["posterior"], h["id"]))
        tied = [h for h in state["hypotheses"] if abs(h["posterior"] - leader["posterior"]) < 1e-9]
        claim_paths, record_paths = [], []
        for h in tied:  # with no evidence yet, every equally likely suspect is traced
            person = h["person_id"]
            first = names[person].removeprefix("Dr. ").split()[0]
            claims = self._call(trace, f"Tracing {first}'s claimed movements", "query_relationships",
                                case_id=case_id, entity_id=person, relationship_type="claims", max_depth=3)
            records = self._call(trace, f"Cross-checking records that place {first}", "query_relationships",
                                 case_id=case_id, entity_id=person, relationship_type="records", max_depth=3)
            claim_paths += [r["path"] for r in claims["untrusted_case_content"]]
            record_paths += [r["path"] for r in records["untrusted_case_content"]]
        self._call(trace, "Listing eligible investigations", "list_available_actions", case_id=case_id)
        evaluation = self._call(trace, "Comparing information gain", "evaluate_investigations", case_id=case_id)
        stop = evaluation["stopping_assessment"]

        if stop["should_stop"]:
            closing = self.service.conclude(case_id)
            trace.append({"tool": "conclude", "args": {"case_id": case_id}, "activity": "Closing the investigation", "ok": True})
            report = self._call(trace, "Compiling the case report", "generate_case_report", case_id=case_id)
            decision = {
                "seq": state["actions_taken"] + 1, "policy": self.policy.name, "action_id": None,
                "kind": "conclude", "rationale": closing["reason"],
                "explanation": self._closing_text(report, names),
                "trace": trace,
            }
            self.service.record_decision(case_id, decision)
            return {"done": True, "status": closing["status"], "trace": trace, "decision": decision}

        actions = {a["action_id"]: a for a in self.service.evaluate(case_id)["candidates"]}
        action_id, why = self.policy.choose(evaluation, actions, state["actions_taken"] + 1)
        chosen = actions[action_id]
        scored = next(c for c in evaluation["candidates"] if c["action_id"] == action_id)
        result = self._call(trace, chosen["activity"], "execute_investigation", case_id=case_id, action_id=action_id)
        update = self._call(trace, "Updating hypothesis probabilities", "update_hypotheses", case_id=case_id)
        after = self._call(trace, "Re-checking contradictions", "detect_contradictions", case_id=case_id)

        old_ids = {k["id"] for k in before["contradictions"]}
        new_k = [k for k in after["contradictions"] if k["id"] not in old_ids]
        changed_k = [k for k in after["contradictions"]
                     if k["id"] in old_ids and k["status"] != next(o["status"] for o in before["contradictions"] if o["id"] == k["id"])]
        decision = {
            "seq": state["actions_taken"] + 1, "policy": self.policy.name, "action_id": action_id,
            "kind": "investigate", "label": chosen["label"], "rationale": why,
            "eig": scored["expected_information_gain"], "cost": scored["cost"], "utility": scored["utility"],
            "conditioned_on": scored["conditioned_on"],
            "candidates": evaluation["candidates"][:6],
            "focus": {"hypothesis": leader["id"], "person": leader["person_id"],
                      "claim_paths": claim_paths[:6], "record_paths": record_paths[:6]},
            "observation": result["observation"],
            "belief_before": update["prior"], "belief_after": update["posterior"],
            "new_contradictions": [k["id"] for k in new_k],
            "status_changes": [{"id": k["id"], "status": k["status"]} for k in changed_k],
            "evidence_citations": result["discovered_evidence_ids"],
            "stopping_before": stop,
            "trace": trace,
        }
        decision["explanation"] = self._explain(decision, chosen, new_k, changed_k, state)
        self.service.record_decision(case_id, decision)
        return {"done": False, "status": "open", "trace": trace, "decision": decision}

    def run(self, case_id: str, max_steps: int = 25) -> Iterator[dict]:
        for _ in range(max_steps):
            step = self.step(case_id)
            yield step
            if step["done"]:
                return

    # ------------------------------------------------------------------ explanations
    def _explain(self, d: dict, chosen: dict, new_k: list, changed_k: list, state: dict) -> str:
        hyps = {h["id"]: h["description"] for h in state["hypotheses"]}
        before, after = d["belief_before"], d["belief_after"]
        moved = max(after, key=lambda h: abs(after[h] - before[h]))
        lead = max(after, key=after.get)
        parts = [f"Chose “{chosen['label']}” — {d['rationale']}."]
        if d["conditioned_on"]:
            cond = ", ".join(f"{a}={c}" for a, c in d["conditioned_on"].items())
            parts.append(f"Its likelihoods were conditioned on {cond} because both observe the same underlying movement.")
        parts.append(f"Observed [{d['observation']['evidence_id']}]: {d['observation']['untrusted_case_content']}")
        parts.append(f"{hyps[moved]}: {_pct(before[moved])} → {_pct(after[moved])}. "
                     f"Leading: {hyps[lead]} at {_pct(after[lead])}.")
        for k in new_k:
            parts.append(f"New {k['classification'].replace('_', ' ')} [{k['id']}, {k['status']}].")
        for k in changed_k:
            parts.append(f"Contradiction {k['id']} is now {k['status']}.")
        return " ".join(parts)

    def _closing_text(self, report: dict, names: dict) -> str:
        if report["outcome"] == "solved":
            bundles = ", ".join(report["supporting_bundles"]["counted"])
            return (f"Case closed: {report['conclusion']} Confidence {_pct(report['confidence'])} under the case model, "
                    f"supported by independent bundles: {bundles}. Cost {report['total_cost']}/{report['budget']}.")
        return f"Case closed as inconclusive — {report['status_reason']}. {report['conclusion']}"
