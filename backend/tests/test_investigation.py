import pytest

from paradox.service import CaseNotStarted, InvalidAction, VersionConflict


def test_case_loads_with_initial_statements_and_hidden_evidence(case1):
    st = case1.state("case001")
    assert st["status"] == "open"
    assert {s["id"] for s in st["statements"]} == {"st_alice_1", "st_ben_1", "st_clara_1"}
    assert st["observations"] == []
    discovered = {e["id"] for e in st["evidence"]}
    assert discovered == {"ev_incident_report", "ev_access_roster", "ev_anonymous_note"}
    g = case1.graph("case001")
    hidden = [n for n in g["nodes"] if n["type"] == "Evidence" and not n["properties"]["discovered"]]
    assert hidden and all(n["properties"]["description"] == "" for n in hidden)
    assert not any(n["type"] == "Observation" for n in g["nodes"])


def test_execution_persists_observation_and_bumps_version(case1):
    v0 = case1.state("case001")["graph_version"]
    r = case1.investigate("case001", "act_lab_door")
    assert r["charged"] and r["graph_version"] == v0 + 1
    st = case1.state("case001")
    assert [o["action_id"] for o in st["observations"]] == ["act_lab_door"]
    assert st["spent"] == 2
    assert len(st["belief_history"]) == 2
    rows = case1.session("case001").store.query(
        "MATCH (o:Observation)-[:RESULT_OF]->(a:InvestigationAction {id: 'act_lab_door'}), "
        "(o)-[:REVEALS]->(e:Evidence {discovered: true}) RETURN o.outcome_code AS code, e.id AS e"
    )
    assert rows == [{"code": "no_badge", "e": "src_lab_door"}]


def test_execution_is_idempotent_and_never_double_charges(case1):
    first = case1.investigate("case001", "act_entrance_log")
    again = case1.investigate("case001", "act_entrance_log")
    assert again["charged"] is False and again["already_executed"] is True
    st = case1.state("case001")
    assert st["spent"] == 1 and st["actions_taken"] == 1
    assert again["graph_version"] == first["graph_version"]


def test_prerequisites_are_enforced_from_graph(case1):
    with pytest.raises(InvalidAction, match="requires"):
        case1.investigate("case001", "act_passage_cam")
    case1.investigate("case001", "act_maint_log")
    assert case1.investigate("case001", "act_passage_cam")["charged"]


def test_contradiction_prerequisite_unlocks_follow_up(case1):
    cands = {c["action_id"]: c for c in case1.evaluate("case001")["candidates"]}
    assert not cands["act_confront_ben"]["eligible"]
    case1.investigate("case001", "act_entrance_log")  # Ben's badge exits at 9:08 → contradicts his statement
    cands = {c["action_id"]: c for c in case1.evaluate("case001")["candidates"]}
    assert cands["act_confront_ben"]["eligible"]
    assert not cands["act_confront_alice"]["eligible"]


def test_budget_and_unknown_actions(case1):
    with pytest.raises(InvalidAction, match="unknown"):
        case1.investigate("case001", "act_does_not_exist")
    store = case1.session("case001").store
    store.update_case(spent=11)
    cands = {c["action_id"]: c for c in case1.evaluate("case001")["candidates"]}
    assert not cands["act_lab_door"]["eligible"]
    assert any("exceeds remaining budget" in r for r in cands["act_lab_door"]["ineligible_reasons"])
    assert cands["act_entrance_log"]["eligible"]


def test_optimistic_version_check(case1):
    with pytest.raises(VersionConflict):
        case1.investigate("case001", "act_lab_door", expected_graph_version=99)


def test_reset_restores_original_state(case1):
    case1.investigate("case001", "act_lab_door")
    case1.start("case001")
    st = case1.state("case001")
    assert st["observations"] == [] and st["spent"] == 0 and st["graph_version"] == 0


def test_unstarted_case_is_rejected(service):
    with pytest.raises(CaseNotStarted):
        service.state("case002")


def test_cases_reset_independently(service):
    service.start("case001")
    service.start("case002")
    service.investigate("case001", "act_lab_door")
    assert service.state("case002")["actions_taken"] == 0
    service.start("case002")
    assert service.state("case001")["actions_taken"] == 1


def test_hard_limits_close_case_as_inconclusive(case1):
    store = case1.session("case001").store
    store.update_case(max_actions=1)
    r = case1.investigate("case001", "act_meeting")
    assert r["status"] == "inconclusive"
    report = case1.report("case001")
    assert report["outcome"] == "inconclusive"
    assert report["ground_truth"]["sealed"] is False
