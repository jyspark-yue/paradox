"""LLM controller loop, exercised with a scripted fake client (no network)."""

from types import SimpleNamespace

from paradox.agent.llm import LLMDetective
from paradox.agent.tools import anthropic_tool_definitions


def _tool(id_, name, **input_):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


def _text(t):
    return SimpleNamespace(type="text", text=t)


class FakeClient:
    def __init__(self, script):
        self.script = list(script)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        content, stop = self.script.pop(0)
        return SimpleNamespace(content=content, stop_reason=stop)


def test_tool_definitions_are_strict_and_closed():
    defs = anthropic_tool_definitions()
    assert len(defs) == 8
    for d in defs:
        assert d["strict"] is True
        assert d["input_schema"]["additionalProperties"] is False
        assert set(d["input_schema"]["required"]) == set(d["input_schema"]["properties"])


def test_llm_step_enforces_evaluate_first_and_single_execution(case1):
    script = [
        ([_tool("t1", "execute_investigation", case_id="case001", action_id="act_lab_door")], "tool_use"),
        ([_tool("t2", "evaluate_investigations", case_id="case001")], "tool_use"),
        ([_tool("t3", "execute_investigation", case_id="case001", action_id="act_lab_door"),
          _tool("t4", "execute_investigation", case_id="case001", action_id="act_meeting")], "tool_use"),
        ([_text("Chose the lab door log [src_lab_door]: highest utility. No badge entries; Ben now leads.")], "end_turn"),
    ]
    client = FakeClient(script)
    step = LLMDetective(case1, client=client).step("case001")
    d = step["decision"]
    assert d["action_id"] == "act_lab_door" and d["matched_top_utility"] is True
    errors = [t for t in d["trace"] if not t["ok"]]
    assert "evaluate_investigations before" in errors[0]["error"]
    assert "only one" in errors[1]["error"]
    assert case1.state("case001")["actions_taken"] == 1
    # Fallback opt-in and no ground truth anywhere in what was sent to the model.
    sent = str(client.requests)
    assert client.requests[0]["fallbacks"] == "default"
    assert "narrative" not in sent and "truth" not in sent.lower().replace("ground-truth", "")


def test_llm_ineligible_choice_is_rejected_by_simulator_rules(case1):
    script = [
        ([_tool("t1", "evaluate_investigations", case_id="case001")], "tool_use"),
        ([_tool("t2", "execute_investigation", case_id="case001", action_id="act_passage_cam")], "tool_use"),
        ([_tool("t3", "execute_investigation", case_id="case001", action_id="act_entrance_log")], "tool_use"),
        ([_text("Passage camera needs the maintenance log first, so I checked the entrance log [src_entrance_log].")], "end_turn"),
    ]
    step = LLMDetective(case1, client=FakeClient(script)).step("case001")
    assert step["decision"]["action_id"] == "act_entrance_log"
    assert step["decision"]["matched_top_utility"] is False
    assert any("requires" in (t.get("error") or "") for t in step["decision"]["trace"])
