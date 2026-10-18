"""Baseline evaluation (PRD §16): random vs fixed-order vs information-gain planners.

Usage:  python -m paradox.eval.run_eval [--seeds 20] [--out eval_results]

Worlds are sampled from each case's generation model conditioned on every possible culprit, so the
same seeds give every policy the identical world. Results are prototype measurements on synthetic
cases, not claims about real investigations.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from paradox.agent.controller import DetectiveAgent
from paradox.cases.loader import list_case_ids, load_public_case
from paradox.engine import termination
from paradox.service import InvestigationService

POLICIES = ["eig", "fixed", "random"]


def run_one(service: InvestigationService, case_id: str, policy: str, *, truth: str | None, seed: int,
            mode: str = "sampled", variant: str = "A", perturbations: list[str] | None = None) -> dict:
    service.start(case_id, variant=variant, mode=mode, seed=seed, truth=truth, perturbations=perturbations)
    agent = DetectiveAgent(service, policy=policy, seed=seed)
    for _ in agent.run(case_id):
        pass
    report = service.report(case_id)
    invalid = sum(1 for d in service.state(case_id)["decisions"] for t in d.get("trace", []) if not t["ok"])
    gt = report["ground_truth"]
    return {
        "case": case_id, "policy": policy, "truth": gt["truth"], "seed": seed,
        "outcome": report["outcome"], "leader": report["leading_hypothesis"],
        "correct": gt["correct_solve"], "wrong_solve": report["outcome"] == "solved" and not gt["leading_matches_truth"],
        "cost": report["total_cost"], "actions": report["actions_taken"], "budget": report["budget"],
        "contradictions": len(report["contradictions"]), "invalid_actions": invalid,
        "confidence": report["confidence"],
        "sequence": [h["action_id"] for h in report["investigation_history"]],
        "contradiction_signature": sorted(f"{k['rule']}:{k['status']}:{'+'.join(sorted(k['statement_ids']))}"
                                          for k in report["contradictions"]),
    }


def initial_eligibility(service: InvestigationService, case_id: str, perturbations: list[str]) -> set[str]:
    service.start(case_id, perturbations=perturbations)
    return {c["action_id"] for c in service.evaluate(case_id)["candidates"] if c["eligible"]}


def summarise(rows: list[dict]) -> dict:
    n = len(rows)
    solved = [r for r in rows if r["outcome"] == "solved"]
    return {
        "runs": n,
        "accuracy": sum(r["correct"] for r in rows) / n,
        "resolved_within_budget": len(solved) / n,
        "wrong_conclusions": sum(r["wrong_solve"] for r in rows),
        "mean_cost": statistics.mean(r["cost"] for r in rows),
        "mean_actions": statistics.mean(r["actions"] for r in rows),
        "mean_contradictions": statistics.mean(r["contradictions"] for r in rows),
        "invalid_actions": sum(r["invalid_actions"] for r in rows),
        "mean_cost_when_correct": statistics.mean(r["cost"] for r in rows if r["correct"]) if any(r["correct"] for r in rows) else None,
        # Calibration: mean reported confidence vs. empirical accuracy among solved runs.
        "mean_confidence_solved": statistics.mean(r["confidence"] for r in solved) if solved else None,
        "accuracy_of_solved": (sum(r["correct"] for r in solved) / len(solved)) if solved else None,
    }


def perturbation_demo(service: InvestigationService) -> list[dict]:
    out = []
    for cid in list_case_ids():
        case = load_public_case(cid)
        base = run_one(service, cid, "eig", truth=None, seed=0, mode="scripted")
        base_elig = initial_eligibility(service, cid, [])
        for p in case.perturbations:
            pert = run_one(service, cid, "eig", truth=None, seed=0, mode="scripted", perturbations=[p.id])
            elig = initial_eligibility(service, cid, [p.id])
            out.append({
                "case": cid, "perturbation": p.id, "baseline_sequence": base["sequence"],
                "perturbed_sequence": pert["sequence"], "baseline_outcome": base["outcome"],
                "perturbed_outcome": pert["outcome"], "sequence_changed": base["sequence"] != pert["sequence"],
                "newly_ineligible": sorted(base_elig - elig), "newly_eligible": sorted(elig - base_elig),
                "contradictions_removed": sorted(set(base["contradiction_signature"]) - set(pert["contradiction_signature"])),
                "contradictions_added": sorted(set(pert["contradiction_signature"]) - set(base["contradiction_signature"])),
            })
    return out


def fmt(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--out", default="eval_results")
    args = ap.parse_args()
    service = InvestigationService(graph_prefix="paradox_eval")
    t0 = time.time()

    rows: list[dict] = []
    for cid in list_case_ids():
        for h in load_public_case(cid).hypotheses:
            for seed in range(args.seeds):
                for policy in POLICIES:
                    rows.append(run_one(service, cid, policy, truth=h.id, seed=seed))

    ablation: list[dict] = []
    termination.CONTRADICTION_AWARE = False
    try:
        for cid in list_case_ids():
            for h in load_public_case(cid).hypotheses:
                for seed in range(args.seeds):
                    ablation.append(run_one(service, cid, "eig", truth=h.id, seed=seed))
    finally:
        termination.CONTRADICTION_AWARE = True

    scripted = [run_one(service, cid, "eig", truth=None, seed=0, mode="scripted", variant=v)
                for cid in list_case_ids() for v in ("A", "B")]
    perturb = perturbation_demo(service)

    lines = ["# Paradox evaluation", "",
             f"{args.seeds} sampled worlds per (case × true culprit); identical worlds for every policy. "
             "Prototype measurements on synthetic cases.", ""]
    lines += ["## Policies (RQ1, RQ2)", "",
              "| case | policy | runs | accuracy | resolved in budget | wrong conclusions | mean cost | mean actions | mean confidence (solved) | accuracy of solved |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    summary = {}
    for cid in list_case_ids() + ["all"]:
        for policy in POLICIES:
            sel = [r for r in rows if r["policy"] == policy and (cid == "all" or r["case"] == cid)]
            s = summarise(sel)
            summary[f"{cid}/{policy}"] = s
            lines.append(f"| {cid} | {policy} | {s['runs']} | {fmt(s['accuracy'])} | {fmt(s['resolved_within_budget'])} | "
                         f"{s['wrong_conclusions']} | {fmt(s['mean_cost'])} | {fmt(s['mean_actions'])} | "
                         f"{fmt(s['mean_confidence_solved'])} | {fmt(s['accuracy_of_solved'])} |")
    eig_all = summarise([r for r in rows if r["policy"] == "eig"])
    abl = summarise(ablation)
    summary["ablation/no_contradiction_awareness"] = abl
    lines += ["", "## Contradiction-aware sufficiency ablation (RQ3)", "",
              "| configuration | accuracy | wrong conclusions | mean cost |", "|---|---|---|---|",
              f"| contradiction-aware (default) | {fmt(eig_all['accuracy'])} | {eig_all['wrong_conclusions']} | {fmt(eig_all['mean_cost'])} |",
              f"| contradictions ignored | {fmt(abl['accuracy'])} | {abl['wrong_conclusions']} | {fmt(abl['mean_cost'])} |"]
    lines += ["", "## Scripted demo variants", "", "| case | truth | outcome | correct | cost | sequence |", "|---|---|---|---|---|---|"]
    for r in scripted:
        lines.append(f"| {r['case']} | {r['truth']} | {r['outcome']} | {r['correct']} | {r['cost']} | {' → '.join(r['sequence'])} |")
    lines += ["", "## Graph perturbations (RQ4)", "",
              "| case | perturbation | baseline sequence | perturbed sequence | eligibility change at start | contradiction change |",
              "|---|---|---|---|---|---|"]
    for p in perturb:
        elig = ", ".join([f"−{a}" for a in p["newly_ineligible"]] + [f"+{a}" for a in p["newly_eligible"]]) or "none"
        kchg = "; ".join([f"−{k}" for k in p["contradictions_removed"]] + [f"+{k}" for k in p["contradictions_added"]]) or "none"
        lines.append(f"| {p['case']} | {p['perturbation']} | {' → '.join(p['baseline_sequence'])} | "
                     f"{' → '.join(p['perturbed_sequence'])} | {elig} | {kchg} |")
    lines += ["", f"_Runtime {time.time() - t0:.1f}s._"]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.md").write_text("\n".join(lines) + "\n")
    (out / "results.json").write_text(json.dumps({"summary": summary, "runs": rows, "ablation": ablation,
                                                  "scripted": scripted, "perturbations": perturb}, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
