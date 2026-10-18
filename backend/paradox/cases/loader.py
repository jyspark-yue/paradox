"""Loads the public (agent-readable) half of case definitions."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from paradox.cases.schema import PublicCase

DATA_DIR = Path(__file__).parent / "data"


def list_case_ids() -> list[str]:
    return sorted(p.name for p in DATA_DIR.iterdir() if (p / "public.yaml").exists())


@lru_cache(maxsize=None)
def load_public_case(case_id: str) -> PublicCase:
    path = DATA_DIR / case_id / "public.yaml"
    if not path.exists():
        raise KeyError(f"unknown case '{case_id}'")
    with path.open() as fh:
        return PublicCase.model_validate(yaml.safe_load(fh))
