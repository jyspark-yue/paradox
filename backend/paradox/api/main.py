"""FastAPI backend (PRD §14)."""

from __future__ import annotations

import json
import os

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from paradox.agent.controller import AgentHalted, DetectiveAgent
from paradox.agent.llm import LLMDetective, llm_available
from paradox.agent.tools import ToolError
from paradox.graph.db import GraphUnavailableError
from paradox.service import InvestigationError, InvestigationService

app = FastAPI(title="Paradox", version="1.0", description="Graph-native autonomous detective agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.environ.get("PARADOX_CORS", "").split(",") if o],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"], allow_headers=["*"],
)
service = InvestigationService()


@app.exception_handler(InvestigationError)
def _investigation_error(_, exc: InvestigationError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(GraphUnavailableError)
def _graph_error(_, exc: GraphUnavailableError):
    return JSONResponse(status_code=503, content={"detail": f"graph store unavailable: {exc}"})


class StartRequest(BaseModel):
    variant: str = Field(default="A", pattern="^[AB]$")
    mode: str = Field(default="scripted", pattern="^(scripted|sampled)$")
    seed: int = 0
    perturbations: list[str] = Field(default_factory=list)


class InvestigateRequest(BaseModel):
    action_id: str
    expected_graph_version: int | None = None


class AgentRequest(BaseModel):
    policy: str = Field(default="eig", pattern="^(eig|random|fixed|llm)$")
    seed: int = 0
    max_steps: int = Field(default=20, ge=1, le=40)


class PerturbRequest(BaseModel):
    perturbation_id: str


def _agent(policy: str, seed: int):
    if policy == "llm":
        ok, why = llm_available()
        if not ok:
            raise HTTPException(status_code=400, detail=f"LLM agent unavailable: {why}")
        return LLMDetective(service)
    return DetectiveAgent(service, policy=policy, seed=seed)


@app.get("/config")
def config():
    ok, detail = llm_available()
    return {"llm_available": ok, "llm_detail": detail, "policies": ["eig", "random", "fixed"] + (["llm"] if ok else [])}


@app.get("/cases")
def list_cases():
    return service.list_cases()


@app.post("/cases/{case_id}/start")
def start(case_id: str, req: StartRequest | None = None):
    req = req or StartRequest()
    try:
        return service.start(case_id, variant=req.variant, mode=req.mode, seed=req.seed,
                             perturbations=req.perturbations)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/cases/{case_id}/state")
def state(case_id: str):
    return service.state(case_id)


@app.get("/cases/{case_id}/graph")
def graph(case_id: str):
    return service.graph(case_id)


@app.get("/cases/{case_id}/actions")
def actions(case_id: str):
    return service.evaluate(case_id)


@app.post("/cases/{case_id}/investigate")
def investigate(case_id: str, req: InvestigateRequest):
    result = service.investigate(case_id, req.action_id, req.expected_graph_version)
    if result["charged"]:
        service.record_decision(case_id, {
            "seq": result["observation"]["seq"], "policy": "manual", "action_id": req.action_id, "kind": "investigate",
            "label": result["observation"]["action_label"], "rationale": "Selected manually by the user.",
            "observation": result["observation"], "belief_before": result["hypotheses"]["before"],
            "belief_after": result["hypotheses"]["after"],
            "new_contradictions": [k["id"] for k in result["new_contradictions"]],
            "explanation": f"Manual investigation: {result['observation']['description']}",
        })
    return result


@app.post("/cases/{case_id}/conclude")
def conclude(case_id: str):
    return service.conclude(case_id)


@app.post("/cases/{case_id}/perturb")
def perturb(case_id: str, req: PerturbRequest):
    return service.perturb(case_id, req.perturbation_id)


@app.post("/cases/{case_id}/agent/step")
def agent_step(case_id: str, req: AgentRequest | None = None):
    req = req or AgentRequest()
    try:
        step = _agent(req.policy, req.seed).step(case_id)
    except (AgentHalted, ToolError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {**step, "state": service.state(case_id)}


@app.post("/cases/{case_id}/agent/run")
def agent_run(case_id: str, req: AgentRequest | None = None, stream: bool = Query(default=True)):
    req = req or AgentRequest()
    agent = _agent(req.policy, req.seed)

    if not stream:
        steps = []
        try:
            steps.extend(agent.run(case_id, req.max_steps))
        except (AgentHalted, ToolError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"steps": steps, "report": service.report(case_id)}

    def events():
        try:
            for _ in range(req.max_steps):
                step = agent.step(case_id)
                payload = {**step, "state": service.state(case_id), "graph": service.graph(case_id)}
                yield f"event: step\ndata: {json.dumps(payload, default=str)}\n\n"
                if step["done"]:
                    break
            yield f"event: report\ndata: {json.dumps(service.report(case_id), default=str)}\n\n"
        except (AgentHalted, ToolError, InvestigationError) as exc:
            yield f"event: halted\ndata: {json.dumps({'detail': str(exc)})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@app.get("/cases/{case_id}/report")
def report(case_id: str):
    return service.report(case_id)


@app.get("/cases/{case_id}/history")
def history(case_id: str):
    st = service.state(case_id)
    return {"observations": st["observations"], "belief_history": st["belief_history"], "decisions": st["decisions"]}
