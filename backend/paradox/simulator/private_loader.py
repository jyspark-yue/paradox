"""Loads simulator-private case data. Only ``paradox.simulator`` may import this module."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from paradox.cases.loader import load_public_case
from paradox.simulator.private_schema import PrivateCase

PRIVATE_DIR = Path(__file__).parent / "private"


@lru_cache(maxsize=None)
def load_private_case(case_id: str) -> PrivateCase:
    path = PRIVATE_DIR / case_id / "private.yaml"
    with path.open() as fh:
        private = PrivateCase.model_validate(yaml.safe_load(fh))
    _validate_against_public(private)
    return private


def _validate_against_public(private: PrivateCase) -> None:
    public = load_public_case(private.case_id)
    hyp_ids = {h.id for h in public.hypotheses}
    for action in public.actions:
        codes = {o.code for o in action.outcomes}
        reveal_codes = set(private.reveals.get(action.id, {}))
        if reveal_codes != codes:
            raise ValueError(f"{private.case_id}/{action.id}: reveals must cover outcomes {codes}")
    for variant in private.variants.values():
        if variant.truth not in hyp_ids:
            raise ValueError(f"variant {variant.id}: unknown truth {variant.truth}")
        for act, code in variant.outcomes.items():
            if code not in private.reveals.get(act, {}):
                raise ValueError(f"variant {variant.id}: invalid outcome {act}={code}")
