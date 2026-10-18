import math

import pytest

from paradox.cases.loader import list_case_ids, load_public_case
from paradox.engine.probability import (
    LikelihoodModel,
    bayes_update,
    entropy,
    expected_information_gain,
    posterior_sequence,
)


def test_both_cases_load_and_meet_dataset_targets():
    assert list_case_ids() == ["case001", "case002"]
    for cid in list_case_ids():
        case = load_public_case(cid)
        assert len(case.hypotheses) >= 3
        assert len(case.actions) >= 6
        assert abs(sum(h.prior for h in case.hypotheses) - 1) < 1e-9


def test_model_read_from_graph_matches_case_file(case1):
    model = LikelihoodModel.from_graph(case1.session("case001").store)
    case = load_public_case("case001")
    for action in case.actions:
        _, table = model.table_for(action.id, {})
        assert table == action.likelihoods


def test_bayes_update_matches_hand_calculation(case1):
    model = LikelihoodModel.from_graph(case1.session("case001").store)
    post = bayes_update(model, model.priors, "act_lab_door", "no_badge", {})
    # 0.85 / (0.25 + 0.85 + 0.25)
    assert post["H2"] == pytest.approx(0.85 / 1.35)
    assert sum(post.values()) == pytest.approx(1.0)


def test_posteriors_stay_normalised_for_every_outcome_sequence(case1):
    model = LikelihoodModel.from_graph(case1.session("case001").store)
    for a in model.outcomes:
        for code in model.outcomes[a]:
            seq = posterior_sequence(model, [("act_maint_log", "passage_override"), (a, code)]) \
                if a != "act_maint_log" else posterior_sequence(model, [(a, code)])
            for belief in seq:
                assert sum(belief.values()) == pytest.approx(1.0)
                assert all(0 <= p <= 1 for p in belief.values())


def test_correlated_camera_uses_conditional_table(case1):
    """Camera and maintenance log observe the same movement: conditioning must reduce the camera's weight."""
    model = LikelihoodModel.from_graph(case1.session("case001").store)
    after_log = posterior_sequence(model, [("act_maint_log", "passage_override")])[-1]
    cond, _ = model.table_for("act_passage_cam", {"act_maint_log": "passage_override"})
    assert cond == {"act_maint_log": "passage_override"}
    dependent = bayes_update(model, after_log, "act_passage_cam", "figure_ben", {"act_maint_log": "passage_override"})
    naive = bayes_update(model, after_log, "act_passage_cam", "figure_ben", {})  # base table = independence
    assert dependent["H2"] < naive["H2"]


def test_eig_bounds_and_determinism(case1):
    model = LikelihoodModel.from_graph(case1.session("case001").store)
    h0 = entropy(model.priors)
    assert h0 == pytest.approx(math.log2(3))
    for a in model.outcomes:
        eig, preds = expected_information_gain(model, model.priors, a, {})
        assert 0 <= eig <= h0 + 1e-9
        assert sum(p["probability"] for p in preds) == pytest.approx(1.0)
        assert eig == expected_information_gain(model, model.priors, a, {})[0]


def test_ranking_is_reproducible_and_cost_aware(case1):
    first = case1.evaluate("case001")["ranked"]
    second = case1.evaluate("case001")["ranked"]
    assert first == second
    assert first[0] == "act_lab_door"
    cands = {c["action_id"]: c for c in case1.evaluate("case001")["candidates"]}
    for c in cands.values():
        if c["eligible"]:
            assert c["utility"] == pytest.approx(c["eig"] / c["cost"])
