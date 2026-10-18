import json

from fastapi.testclient import TestClient

from paradox.api import main


def test_end_to_end_api_flow(monkeypatch):
    from paradox.service import InvestigationService

    monkeypatch.setattr(main, "service", InvestigationService(graph_prefix="paradox_apitest"))
    c = TestClient(main.app)

    assert c.get("/cases/case001/state").status_code == 404
    cases = c.get("/cases").json()
    assert {x["id"] for x in cases} == {"case001", "case002"}

    start = c.post("/cases/case001/start", json={"variant": "A"}).json()
    assert start["state"]["graph_version"] == 0 and start["actions"]

    graph = c.get("/cases/case001/graph").json()
    assert {n["type"] for n in graph["nodes"]} >= {"Person", "Statement", "Event", "Evidence", "Hypothesis"}

    r = c.post("/cases/case001/investigate", json={"action_id": "act_lab_door", "expected_graph_version": 0})
    assert r.status_code == 200 and r.json()["graph_version"] == 1
    assert c.post("/cases/case001/investigate", json={"action_id": "act_entrance_log",
                                                       "expected_graph_version": 0}).status_code == 409
    assert c.post("/cases/case001/investigate", json={"action_id": "act_passage_cam"}).status_code == 422

    step = c.post("/cases/case001/agent/step", json={"policy": "eig"}).json()
    assert step["decision"]["policy"] == "eig"

    stream = c.post("/cases/case001/agent/run", json={"policy": "eig"})
    events = [blk for blk in stream.text.split("\n\n") if blk.strip()]
    assert events[-1].startswith("event: report")
    report = json.loads(events[-1].split("data: ", 1)[1])
    assert report["outcome"] == "solved" and report["ground_truth"]["correct_solve"]

    history = c.get("/cases/case001/history").json()
    assert [o["seq"] for o in history["observations"]] == list(range(1, len(history["observations"]) + 1))
    assert c.post("/cases/case001/agent/step", json={"policy": "llm"}).status_code == 400
