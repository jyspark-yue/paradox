"""The investigation simulator: holds protected ground truth and returns predefined observations.

Agent-facing code never receives a Simulator instance; it only sees the observation that the
investigation service writes into the graph after an action has been validated.
"""

from __future__ import annotations

import random

from paradox.cases.loader import load_public_case
from paradox.simulator.private_loader import load_private_case
from paradox.simulator.private_schema import Reveal


class Simulator:
    def __init__(self, case_id: str, variant: str = "A", mode: str = "scripted", seed: int = 0,
                 truth: str | None = None):
        if mode not in ("scripted", "sampled"):
            raise ValueError("mode must be 'scripted' or 'sampled'")
        self._public = load_public_case(case_id)
        self._private = load_private_case(case_id)
        if variant not in self._private.variants:
            raise KeyError(f"unknown variant '{variant}' for {case_id}")
        self._variant = self._private.variants[variant]
        self._mode = mode
        self._seed = seed
        self._truth = truth or self._variant.truth
        if truth and mode == "scripted" and truth != self._variant.truth:
            raise ValueError("a truth override requires sampled mode")
        self._actions = {a.id: a for a in self._public.actions}

    @property
    def config(self) -> dict:
        """Non-sensitive session description (variant label, mode, seed)."""
        return {"variant": self._variant.id, "mode": self._mode, "seed": self._seed}

    def reveal(self, action_id: str, observed: dict[str, str]) -> tuple[str, Reveal]:
        if action_id not in self._actions:
            raise KeyError(action_id)
        if self._mode == "scripted" and action_id in self._variant.outcomes:
            code = self._variant.outcomes[action_id]
        else:
            code = self._sample(action_id, observed)
        return code, self._private.reveals[action_id][code]

    def _sample(self, action_id: str, observed: dict[str, str]) -> str:
        """Draw an outcome from the generation model conditioned on the true hypothesis."""
        action = self._actions[action_id]
        table, best = action.likelihoods, -1
        for cond in action.conditional:
            if all(observed.get(a) == c for a, c in cond.given.items()) and len(cond.given) > best:
                table, best = cond.likelihoods, len(cond.given)
        dist = table[self._truth]
        rng = random.Random(f"{self._seed}:{action_id}")
        r, acc = rng.random(), 0.0
        for o in action.outcomes:
            acc += dist[o.code]
            if r < acc:
                return o.code
        return action.outcomes[-1].code

    def disclose_truth(self, case_closed: bool) -> dict:
        """Ground truth is released only after the investigation has been closed."""
        if not case_closed:
            raise PermissionError("ground truth is sealed until the case is closed")
        out = {"truth": self._truth, "variant": self._variant.id, "mode": self._mode}
        if self._mode == "scripted":
            out["narrative"] = self._variant.narrative.strip()
        return out
