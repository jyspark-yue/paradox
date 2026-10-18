def _by_rule(service, case_id):
    out = {}
    for k in service.state(case_id)["contradictions"]:
        out.setdefault(k["rule"], []).append(k)
    return out


def test_no_contradictions_before_evidence(case1):
    assert case1.state("case001")["contradictions"] == []


def test_rule_b_statement_vs_record_uses_travel_time(case1):
    case1.investigate("case001", "act_entrance_log")
    ks = _by_rule(case1, "case001")
    assert len(ks["B"]) == 1
    k = ks["B"][0]
    assert k["statement_ids"] == ["st_ben_1"] and k["evidence_ids"] == ["src_entrance_log"]
    assert k["status"] == "supported"
    rows = case1.session("case001").store.query(
        "MATCH (e:Evidence {id: 'src_entrance_log'})-[:CONTRADICTS]->(s:Statement) RETURN s.id AS s"
    )
    assert rows == [{"s": "st_ben_1"}]


def test_rule_a_testimony_vs_testimony_is_unresolved_until_records_settle_it(case1):
    case1.investigate("case001", "act_guard")
    ks = _by_rule(case1, "case001")
    assert [k["status"] for k in ks["A"]] == ["unresolved"]
    assert set(ks["A"][0]["statement_ids"]) == {"st_ben_1", "st_marcus_1"}
    case1.investigate("case001", "act_entrance_log")
    ks = _by_rule(case1, "case001")
    assert [k["status"] for k in ks["A"]] == ["supported"]


def test_corroboration_is_not_a_contradiction(case1):
    case1.investigate("case001", "act_meeting")
    assert case1.state("case001")["contradictions"] == []
    rows = case1.session("case001").store.query(
        "MATCH (e:Evidence {id: 'src_meeting'})-[:CORROBORATES]->(s:Statement) RETURN s.id AS s"
    )
    assert rows == [{"s": "st_clara_1"}]


def test_rule_d_record_conflict_then_explained(case2):
    case2.investigate("case002", "act_archive_door")
    case2.investigate("case002", "act_desk_camera")
    ks = _by_rule(case2, "case002")
    assert [k["status"] for k in ks["D"]] == ["unresolved"]
    case2.investigate("case002", "act_badge_audit")
    ks = _by_rule(case2, "case002")
    assert [k["status"] for k in ks["D"]] == ["explained"]
    assert [k["status"] for k in ks["B"]] == ["explained"]


def test_rule_c_incompatible_predicates(case2):
    case2.investigate("case002", "act_hana")
    ks = _by_rule(case2, "case002")
    assert len(ks["C"]) == 1
    assert set(ks["C"][0]["statement_ids"]) == {"st_esme_1", "st_hana_1"}


def test_unresolved_record_conflict_blocks_evidence_sufficiency(case2):
    case2.investigate("case002", "act_archive_door")
    case2.investigate("case002", "act_desk_camera")
    a = case2.evaluate("case002")["assessment"]
    assert a["leader"] == "HE"
    assert "desk_camera" in a["bundles"]["discounted"]
    assert a["stop"] is False
