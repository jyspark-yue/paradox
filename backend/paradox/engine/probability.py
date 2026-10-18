"""Bayesian hypothesis updating and expected-information-gain scoring.

The likelihood model is read from the graph (OutcomeClass -[:LIKELIHOOD {p, given}]-> Hypothesis).
Correlated observations are handled with explicit conditional tables: when an action's outcome
depends on an earlier observation (e.g. a camera and a door log seeing the same movement), the
most specific conditional table whose ``given`` clause matches the observed history is used
instead of the base table. Observations are therefore never blindly multiplied as independent.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from paradox.graph.store import GraphStore

SUPPORT_RATIO = 1.5


@dataclass
class LikelihoodModel:
    hypotheses: list[str]
    priors: dict[str, float]
    outcomes: dict[str, list[str]]
    # action -> list of (conditions, {hypothesis: {code: p}}), base table has empty conditions
    tables: dict[str, list[tuple[dict[str, str], dict[str, dict[str, float]]]]] = field(default_factory=dict)

    @classmethod
    def from_graph(cls, store: GraphStore) -> "LikelihoodModel":
        hyps = store.hypotheses()
        model = cls(
            hypotheses=[h["id"] for h in hyps],
            priors={h["id"]: h["prior"] for h in hyps},
            outcomes={a: [o["code"] for o in outs] for a, outs in store.outcome_classes().items()},
        )
        grouped: dict[tuple[str, str], dict[str, dict[str, float]]] = {}
        for r in store.likelihood_rows():
            grouped.setdefault((r["action"], r["given"]), {}).setdefault(r["hypothesis"], {})[r["code"]] = r["p"]
        for (action, given), table in sorted(grouped.items()):
            cond = dict(part.split("=", 1) for part in given.split("&")) if given else {}
            model.tables.setdefault(action, []).append((cond, table))
        return model

    def table_for(self, action: str, observed: dict[str, str]) -> tuple[dict[str, str], dict[str, dict[str, float]]]:
        best: tuple[dict[str, str], dict[str, dict[str, float]]] | None = None
        for cond, table in self.tables[action]:
            if all(observed.get(a) == c for a, c in cond.items()):
                if best is None or len(cond) > len(best[0]):
                    best = (cond, table)
        if best is None:
            raise ValueError(f"no likelihood table for {action}")
        return best

    def likelihood(self, action: str, code: str, hypothesis: str, observed: dict[str, str]) -> float:
        return self.table_for(action, observed)[1][hypothesis][code]


def entropy(dist: dict[str, float]) -> float:
    return -sum(p * math.log2(p) for p in dist.values() if p > 0)


def normalize(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("observation has zero probability under every hypothesis")
    return {k: v / total for k, v in weights.items()}


def bayes_update(model: LikelihoodModel, belief: dict[str, float], action: str, code: str,
                 observed: dict[str, str]) -> dict[str, float]:
    return normalize({h: belief[h] * model.likelihood(action, code, h, observed) for h in model.hypotheses})


def posterior_sequence(model: LikelihoodModel, observations: list[tuple[str, str]]) -> list[dict[str, float]]:
    """Belief after each observation, starting with the prior. ``observations`` is (action, code) in order."""
    belief = dict(model.priors)
    seq = [belief]
    observed: dict[str, str] = {}
    for action, code in observations:
        belief = bayes_update(model, belief, action, code, observed)
        observed[action] = code
        seq.append(belief)
    return seq


@dataclass
class ActionScore:
    action_id: str
    eig: float
    cost: int
    utility: float
    outcome_predictions: list[dict]
    conditioned_on: dict[str, str]


def expected_information_gain(model: LikelihoodModel, belief: dict[str, float], action: str,
                              observed: dict[str, str]) -> tuple[float, list[dict]]:
    """EIG(a) = H(H|E) - Σ_o P(o|a,E) H(H|E,o)."""
    h_now = entropy(belief)
    expected_h = 0.0
    predictions = []
    for code in model.outcomes[action]:
        p_o = sum(belief[h] * model.likelihood(action, code, h, observed) for h in model.hypotheses)
        if p_o <= 0:
            predictions.append({"code": code, "probability": 0.0, "posterior_entropy": None})
            continue
        post = bayes_update(model, belief, action, code, observed)
        h_post = entropy(post)
        expected_h += p_o * h_post
        predictions.append({"code": code, "probability": p_o, "posterior_entropy": h_post,
                            "leading_after": max(post, key=post.get), "leading_probability": max(post.values())})
    return max(0.0, h_now - expected_h), predictions


def score_action(model: LikelihoodModel, belief: dict[str, float], action: str, cost: int,
                 observed: dict[str, str]) -> ActionScore:
    eig, preds = expected_information_gain(model, belief, action, observed)
    cond, _ = model.table_for(action, observed)
    return ActionScore(action, eig, cost, eig / cost if cost else eig, preds, cond)


def hypothesis_links(model: LikelihoodModel, action: str, code: str, observed_before: dict[str, str]) -> list[dict]:
    """Explanatory SUPPORTS/CHALLENGES links from a likelihood ratio against the mean of rivals."""
    links = []
    for h in model.hypotheses:
        own = model.likelihood(action, code, h, observed_before)
        rivals = [model.likelihood(action, code, j, observed_before) for j in model.hypotheses if j != h]
        mean_rival = sum(rivals) / len(rivals)
        ratio = own / mean_rival if mean_rival > 0 else float("inf")
        if ratio >= SUPPORT_RATIO:
            links.append({"h": h, "kind": "SUPPORTS", "ratio": round(ratio, 3)})
        elif ratio <= 1 / SUPPORT_RATIO:
            links.append({"h": h, "kind": "CHALLENGES", "ratio": round(ratio, 3)})
    return links


def support_probability(model: LikelihoodModel, belief: dict[str, float], action: str, hypothesis: str,
                        observed: dict[str, str]) -> float:
    """Predictive probability that ``action`` yields an outcome that SUPPORTS ``hypothesis``."""
    total = 0.0
    for code in model.outcomes[action]:
        if any(link["h"] == hypothesis and link["kind"] == "SUPPORTS"
               for link in hypothesis_links(model, action, code, observed)):
            total += sum(belief[h] * model.likelihood(action, code, h, observed) for h in model.hypotheses)
    return total
