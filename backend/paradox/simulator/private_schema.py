"""Schema for simulator-private case data. Never imported by agent-facing code."""

from __future__ import annotations

from pydantic import BaseModel, Field

from paradox.cases.schema import Assertion, Placement


class RevealedStatement(BaseModel):
    id: str
    speaker: str
    content: str
    claim_type: str = "testimony"
    placements: list[Placement] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)


class ExplainsRef(BaseModel):
    """Marks a previously recorded event (by source action + subject) as explained away."""

    action: str
    subject: str
    reason: str


class Reveal(BaseModel):
    description: str
    reliability: float
    provenance: str
    records: list[Placement] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)
    statements: list[RevealedStatement] = Field(default_factory=list)
    explains: list[ExplainsRef] = Field(default_factory=list)


class Variant(BaseModel):
    id: str
    truth: str = Field(description="Ground-truth hypothesis id")
    narrative: str
    outcomes: dict[str, str] = Field(description="Scripted outcome code per action id")


class PrivateCase(BaseModel):
    case_id: str
    reveals: dict[str, dict[str, Reveal]]
    variants: dict[str, Variant]
