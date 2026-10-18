import pytest

from paradox.agent.controller import AgentHalted, DetectiveAgent
from paradox.graph.db import GraphUnavailableError


def _run(service, case_id, policy="eig", seed=0):
    agent = DetectiveAgent(service, policy=policy, seed=seed)
    steps = list(agent.run(case_id))
    return steps, service.report(case_id)


@pytest.mark.parametrize("case_id,variant,truth", [
    ("case001", "A", "H2"), ("case001", "B", "H3"), ("case002", "A", "HE"), ("case002", "B", "HF"),
])
def test_eig_agent_solves_every_variant_within_budget(service, case_id, variant, truth):
    service.start(case_id, variant=variant)
    steps, report = _run(service, case_id)
    assert report["outcome"] == "solved"
    assert report["leading_hypothesis"] == truth
    assert report["ground_truth"]["correct_solve"] is True
    assert report["total_cost"] <= report["budget"]
    assert report["confidence"] >= 0.9
    assert len(report["supporting_bundles"]["counted"]) >= 2
    decisions = [s["decision"] for s in steps if s["decision"] and s["decision"]["kind"] == "investigate"]
    assert all(d["action_id"] == d["candidates"][0]["action_id"] for d in decisions)
    assert [h["seq"] for h in report["investigation_history"]] == list(range(1, len(decisions) + 1))


def test_every_decision_is_recorded_with_trace_and_rationale(case1):
    steps, _ = _run(case1, "case001")
    decisions = case1.state("case001")["decisions"]
    assert len(decisions) == len(steps)
    for d in decisions:
        assert d["rationale"] and d["explanation"] and d["trace"]
        activities = [t["activity"] for t in d["trace"]]
        assert "Comparing information gain" in activities


def test_different_evidence_states_lead_to_different_actions(service):
    second = {}
    for variant in ("A", "B"):
        service.start("case001", variant=variant)
        agent = DetectiveAgent(service)
        agent.step("case001")
        second[variant] = agent.step("case001")["decision"]["action_id"]
    assert second["A"] != second["B"]


def test_baselines_complete_with_the_same_rules(service):
    for policy in ("random", "fixed"):
        service.start("case001", variant="A")
        steps, report = _run(service, "case001", policy=policy, seed=3)
        assert report["status"] in ("solved", "inconclusive")
        assert report["total_cost"] <= report["budget"]


def test_graph_perturbation_changes_eligibility_and_decision(service):
    service.start("case001", variant="A")
    _, base = _run(service, "case001")
    base_actions = [h["action_id"] for h in base["investigation_history"]]
    assert "act_maint_log" in base_actions

    service.start("case001", variant="A", perturbations=["seal_passage"])
    cands = {c["action_id"]: c for c in service.evaluate("case001")["candidates"]}
    assert not cands["act_maint_log"]["eligible"]
    assert any("relevance radius" in r for r in cands["act_maint_log"]["ineligible_reasons"])
    _, sealed = _run(service, "case001")
    sealed_actions = [h["action_id"] for h in sealed["investigation_history"]]
    assert "act_maint_log" not in sealed_actions
    assert sealed_actions != base_actions


def test_changed_structured_claim_changes_contradictions(service):
    service.start("case001", variant="A")
    service.investigate("case001", "act_entrance_log")
    assert any(k["rule"] == "B" for k in service.state("case001")["contradictions"])

    service.start("case001", variant="A", perturbations=["ben_revised_claim"])
    service.investigate("case001", "act_entrance_log")
    assert not any(k["rule"] == "B" for k in service.state("case001")["contradictions"])
    rows = service.session("case001").store.query(
        "MATCH (:Evidence {id: 'src_entrance_log'})-[:CORROBORATES]->(s:Statement) RETURN s.id AS s"
    )
    assert rows == [{"s": "st_ben_1"}]


def test_prompt_injection_in_case_content_is_inert(case1):
    state = case1.state("case001")
    assert any("ignore previous instructions" in e["description"] for e in state["evidence"])
    _, report = _run(case1, "case001")
    assert report["leading_hypothesis"] == "H2"


def test_agent_halts_safely_when_graph_is_unavailable(case1, monkeypatch):
    store = case1.session("case001").store

    def broken(*_a, **_k):
        raise GraphUnavailableError("connection refused")

    monkeypatch.setattr(store, "query", broken)
    with pytest.raises(AgentHalted, match="graph store unavailable"):
        DetectiveAgent(case1).step("case001")


def test_sampled_worlds_are_reproducible(service):
    outcomes = []
    for _ in range(2):
        service.start("case002", variant="A", mode="sampled", seed=11, truth="HG")
        _, report = _run(service, "case002")
        outcomes.append([(h["action_id"], h["outcome"]) for h in report["investigation_history"]])
    assert outcomes[0] == outcomes[1]


def test_corroboration_phase_and_honest_inconclusive_when_support_is_unreachable(service):
    service.start("case002", variant="A", perturbations=["seal_reading_room_door"])
    list(DetectiveAgent(service).run("case002"))
    ev = service.evaluate("case002")
    assert ev["phase"] == "corroborate"
    report = service.report("case002")
    assert report["outcome"] == "inconclusive"
    assert report["leading_hypothesis"] == "HE" and report["confidence"] >= 0.9
    assert "independent support" in report["status_reason"]
    assert report["ground_truth"]["correct_solve"] is False
    assert report["ground_truth"]["leading_matches_truth"] is True
