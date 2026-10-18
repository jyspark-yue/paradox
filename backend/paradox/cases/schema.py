"""Typed schema for the *public* (agent-readable) half of a case definition.

Everything in this module may be seeded into FalkorDB and therefore read by the
detective agent. Ground truth, scripted outcomes and reveal content live in
``paradox.simulator.private`` and are never described by these models.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Person(BaseModel):
    id: str
    name: str
    role: str
    suspect: bool = True
    bio: str = ""
    access: list[str] = Field(default_factory=list, description="Location ids the person can open")


class Location(BaseModel):
    id: str
    name: str
    type: str


class Connection(BaseModel):
    a: str
    b: str
    minutes: int


class Placement(BaseModel):
    """A structured claim/record: `subject` was at `location` from `start` to `end` (minutes since midnight)."""

    subject: str
    location: str
    start: int
    end: int


class Assertion(BaseModel):
    """A structured boolean predicate about a subject over a time window."""

    subject: str
    predicate: str
    value: bool
    start: int
    end: int


class Statement(BaseModel):
    id: str
    speaker: str
    content: str
    recorded_at: int
    claim_type: str = "alibi"
    placements: list[Placement] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)


class Hypothesis(BaseModel):
    id: str
    description: str
    implicates: str
    prior: float


class InitialEvidence(BaseModel):
    id: str
    evidence_type: str
    description: str
    reliability: float
    provenance: str


class EvidenceSource(BaseModel):
    """An evidence item known to exist whose contents are hidden until examined."""

    id: str
    evidence_type: str
    name: str
    location: str | None = None


class OutcomeClass(BaseModel):
    code: str
    label: str


class ConditionalLikelihood(BaseModel):
    given: dict[str, str]
    likelihoods: dict[str, dict[str, float]]


class Action(BaseModel):
    id: str
    type: str
    label: str
    description: str
    cost: int
    bundle: str
    activity: str = Field(description="Agent activity label shown while this action executes")
    target: str | None = None
    examines: str | None = None
    requires: list[str] = Field(default_factory=list)
    requires_contradiction_on: str | None = None
    outcomes: list[OutcomeClass]
    likelihoods: dict[str, dict[str, float]]
    conditional: list[ConditionalLikelihood] = Field(default_factory=list)


class PerturbationOp(BaseModel):
    op: Literal["remove_connection", "add_connection", "revise_statement"]
    a: str | None = None
    b: str | None = None
    minutes: int | None = None
    statement: str | None = None
    content: str | None = None
    placements: list[Placement] | None = None
    assertions: list[Assertion] | None = None


class Perturbation(BaseModel):
    id: str
    label: str
    description: str
    ops: list[PerturbationOp]


class CaseConfig(BaseModel):
    budget: int
    max_actions: int
    confidence_threshold: float = 0.90
    min_supporting_bundles: int = 2
    negligible_eig: float = 0.01
    relevance_minutes: int = 4


class PublicCase(BaseModel):
    id: str
    title: str
    summary: str
    incident_time: int
    window_start: int
    window_end: int
    crime_scene: str
    config: CaseConfig
    people: list[Person]
    locations: list[Location]
    connections: list[Connection]
    hypotheses: list[Hypothesis]
    statements: list[Statement]
    initial_evidence: list[InitialEvidence]
    evidence_sources: list[EvidenceSource]
    actions: list[Action]
    perturbations: list[Perturbation] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate(self) -> "PublicCase":
        hyp_ids = {h.id for h in self.hypotheses}
        loc_ids = {loc.id for loc in self.locations}
        people = {p.id for p in self.people}
        sources = {s.id for s in self.evidence_sources}
        action_ids = {a.id for a in self.actions}
        if abs(sum(h.prior for h in self.hypotheses) - 1.0) > 1e-6:
            raise ValueError(f"{self.id}: priors must sum to 1")
        if self.crime_scene not in loc_ids:
            raise ValueError("crime_scene must be a location")
        for c in self.connections:
            if c.a not in loc_ids or c.b not in loc_ids:
                raise ValueError(f"connection {c} references unknown location")
        for s in self.statements:
            if s.speaker not in people:
                raise ValueError(f"statement {s.id} has unknown speaker")
            for p in s.placements:
                if p.location not in loc_ids or p.subject not in people:
                    raise ValueError(f"statement {s.id} has invalid placement")
        for src in self.evidence_sources:
            if src.location and src.location not in loc_ids:
                raise ValueError(f"source {src.id} has unknown location")
        for a in self.actions:
            codes = {o.code for o in a.outcomes}
            if a.examines and a.examines not in sources:
                raise ValueError(f"action {a.id} examines unknown source")
            if a.target and a.target not in people:
                raise ValueError(f"action {a.id} targets unknown person")
            for r in a.requires:
                if r not in action_ids:
                    raise ValueError(f"action {a.id} requires unknown action {r}")
            tables = [a.likelihoods] + [c.likelihoods for c in a.conditional]
            for table in tables:
                if set(table) != hyp_ids:
                    raise ValueError(f"action {a.id}: likelihood table must cover every hypothesis")
                for hid, dist in table.items():
                    if set(dist) != codes:
                        raise ValueError(f"action {a.id}/{hid}: outcome codes mismatch")
                    if abs(sum(dist.values()) - 1.0) > 1e-6:
                        raise ValueError(f"action {a.id}/{hid}: likelihoods must sum to 1")
            for c in a.conditional:
                for act, code in c.given.items():
                    if act not in action_ids:
                        raise ValueError(f"action {a.id}: conditional on unknown action {act}")
        return self
