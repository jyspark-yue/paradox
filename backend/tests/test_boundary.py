"""Information boundary: the agent-readable graph and tools never expose simulator-private truth."""

import ast
import json
from pathlib import Path

import pytest

from paradox.agent.tools import DetectiveTools, ToolError
from paradox.simulator.private_loader import load_private_case

AGENT_DIR = Path(__file__).resolve().parents[1] / "paradox" / "agent"


def _private_strings(case_id: str, executed: set[str]) -> list[str]:
    private = load_private_case(case_id)
    out = [v.narrative.strip() for v in private.variants.values()]
    for action, reveals in private.reveals.items():
        if action in executed:
            continue
        out += [r.description for r in reveals.values()]
    return out


def _all_tool_output(tools: DetectiveTools, case_id: str) -> str:
    blobs = [
        tools.get_case_state(case_id), tools.detect_contradictions(case_id), tools.list_available_actions(case_id),
        tools.evaluate_investigations(case_id), tools.update_hypotheses(case_id), tools.generate_case_report(case_id),
    ]
    for person in ("alice", "ben", "clara"):
        for rel in ("claims", "records", "contradictions", "neighborhood"):
            blobs.append(tools.query_relationships(case_id, person, rel, 3))
    return json.dumps(blobs, default=str)


def test_graph_contains_no_private_content(case1):
    store = case1.session("case001").store
    dump = json.dumps(store.query("MATCH (n) RETURN properties(n) AS p"), default=str)
    for s in _private_strings("case001", executed=set()):
        assert s not in dump
    assert "truth" not in dump.lower()
    assert "narrative" not in dump.lower()


def test_tool_outputs_leak_nothing_hidden_after_partial_investigation(case1):
    case1.investigate("case001", "act_lab_door")
    case1.investigate("case001", "act_entrance_log")
    out = _all_tool_output(DetectiveTools(case1), "case001")
    for s in _private_strings("case001", executed={"act_lab_door", "act_entrance_log"}):
        assert s not in out, s
    # Result categories and model predictions are public; no realised observation exists for unexecuted actions.
    assert '"obs_03"' not in out


def test_agent_tool_report_omits_ground_truth(case1):
    case1.conclude("case001")
    report = DetectiveTools(case1).generate_case_report("case001")
    assert "ground_truth" not in report


def test_ground_truth_sealed_until_closed(case1):
    assert case1.report("case001")["ground_truth"]["sealed"] is True
    case1.conclude("case001")
    gt = case1.report("case001")["ground_truth"]
    assert gt["sealed"] is False and gt["truth"] == "H2"


def test_agent_package_never_imports_simulator_or_private_data():
    for path in AGENT_DIR.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith("paradox.simulator"), path
            if isinstance(node, ast.Import):
                assert not any(a.name.startswith("paradox.simulator") for a in node.names), path
            if isinstance(node, ast.Attribute):
                assert node.attr not in ("simulator", "disclose_truth"), f"{path}: .{node.attr}"


def test_tool_arguments_are_strictly_validated(case1):
    tools = DetectiveTools(case1)
    with pytest.raises(ToolError, match="invalid arguments"):
        tools.call("query_relationships", {"case_id": "case001", "entity_id": "ben) DETACH DELETE (n",
                                           "relationship_type": "claims", "max_depth": 3})
    with pytest.raises(ToolError, match="invalid arguments"):
        tools.call("query_relationships", {"case_id": "case001", "entity_id": "ben",
                                           "relationship_type": "raw_cypher", "max_depth": 3})
    with pytest.raises(ToolError, match="invalid arguments"):
        tools.call("execute_investigation", {"case_id": "case001", "action_id": "act_lab_door", "outcome": "x"})
    with pytest.raises(ToolError, match="unknown tool"):
        tools.call("reveal_truth", {"case_id": "case001"})


def test_multi_hop_query_returns_paths_and_evidence_ids(case1):
    case1.investigate("case001", "act_entrance_log")
    tools = DetectiveTools(case1)
    claims = tools.query_relationships("case001", "ben", "claims", 3)
    path = claims["untrusted_case_content"][0]["path"]
    assert path[0] == "ben" and path[1] == "st_ben_1" and path[-1] == "outside"
    assert len(path) == 4  # Person → Statement → Event → Location (three hops)
    against = tools.query_relationships("case001", "ben", "contradictions", 3)
    assert "src_entrance_log" in against["evidence_ids"]
