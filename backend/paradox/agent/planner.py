"""Action-selection policies. All policies see the same tool outputs and legal action set."""

from __future__ import annotations

import random

FIXED_ORDER_TYPES = [
    "interview_witness", "question_suspect", "verify_attendance", "verify_alibi",
    "inspect_access_log", "inspect_camera_footage",
]


class EIGPolicy:
    """Paradox's planner: maximise expected information gain per unit cost (deterministic ties by id)."""

    name = "eig"

    def choose(self, evaluation: dict, actions: dict, step: int) -> tuple[str, str]:
        top = evaluation["candidates"][0]
        runner = evaluation["candidates"][1] if len(evaluation["candidates"]) > 1 else None
        n = len(evaluation["candidates"])
        if evaluation.get("phase") == "corroborate":
            why = (f"the leading hypothesis already passes the confidence threshold, so it seeks independent "
                   f"corroboration: highest P(new supporting bundle) per cost among {n} eligible actions "
                   f"({top['p_new_independent_support']:.0%} ÷ cost {top['cost']} = {top['utility']:.3f})")
        else:
            why = (f"highest utility among {n} eligible actions "
                   f"(EIG {top['expected_information_gain']:.3f} bits ÷ cost {top['cost']} = {top['utility']:.3f})")
        if runner:
            why += f"; runner-up {runner['label']} at {runner['utility']:.3f}"
        return top["action_id"], why


class RandomPolicy:
    name = "random"

    def __init__(self, seed: int = 0):
        self.seed = seed

    def choose(self, evaluation: dict, actions: dict, step: int) -> tuple[str, str]:
        ids = sorted(c["action_id"] for c in evaluation["candidates"])
        pick = random.Random(f"{self.seed}:{step}").choice(ids)
        return pick, f"random baseline: uniformly sampled from {len(ids)} eligible actions"


class FixedOrderPolicy:
    name = "fixed"

    def choose(self, evaluation: dict, actions: dict, step: int) -> tuple[str, str]:
        def key(c: dict) -> tuple[int, str]:
            t = actions[c["action_id"]]["type"]
            return (FIXED_ORDER_TYPES.index(t) if t in FIXED_ORDER_TYPES else len(FIXED_ORDER_TYPES), c["action_id"])

        pick = min(evaluation["candidates"], key=key)
        return pick["action_id"], "fixed-order baseline: interviews, then attendance/alibis, access logs, cameras, the rest"


def make_policy(name: str, seed: int = 0):
    if name == "eig":
        return EIGPolicy()
    if name == "random":
        return RandomPolicy(seed)
    if name == "fixed":
        return FixedOrderPolicy()
    raise ValueError(f"unknown policy '{name}'")
