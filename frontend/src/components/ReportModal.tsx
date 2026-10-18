import { useEffect, type ReactNode } from "react";
import type { Report } from "../api/types";
import { bits, humanize, num, pct } from "../lib/format";
import { Badge, Button, PathChain, cx } from "./ui";

interface Props {
  report: Report;
  onClose: () => void;
  onPick: (id: string) => void;
}

export default function ReportModal({ report: r, onClose, onPick }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const solved = r.outcome === "solved";
  const gt = r.ground_truth;
  const pick = (id: string) => {
    onPick(id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm md:p-8" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Case report" className="w-full max-w-4xl rounded-xl border border-board-600 bg-board-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-board-700 px-6 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-ink-400">Case report · {r.case_id}</div>
            <h2 className="mt-0.5 font-serif text-2xl font-bold text-ink-100">{r.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Badge color={solved ? "#34d399" : "#fb923c"} className="px-2 py-1 text-xs uppercase">
              {r.outcome ?? r.status}
            </Badge>
            <Button tone="ghost" size="sm" onClick={onClose} aria-label="Close report">
              Close
            </Button>
          </div>
        </div>

        <div className="grid gap-6 px-6 py-5 md:grid-cols-[1.3fr,1fr]">
          <div className="space-y-5">
            <section>
              <H>Conclusion</H>
              <p className={cx("font-serif text-xl leading-snug", solved ? "text-ink-100" : "text-[#fdba74]")}>{r.conclusion}</p>
              <p className="mt-1 text-xs text-ink-300">{r.status_reason}</p>
              <div className="mt-3 flex items-end gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-400">Confidence</div>
                  <div className="font-mono text-3xl tabular-nums text-hyp">{pct(r.confidence, 1)}</div>
                </div>
                <p className="max-w-sm pb-1 text-[11.5px] italic leading-snug text-ink-400">{r.confidence_note}</p>
              </div>
            </section>

            <section>
              <H>Critical evidence paths</H>
              {r.critical_evidence.length ? (
                <ol className="space-y-2.5">
                  {r.critical_evidence.map((c) => (
                    <li key={c.seq} className="rounded-md border border-board-700 bg-board-850 p-2.5">
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-ink-100">
                          {c.seq}. {c.action}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-400">
                          LR ×{num(c.likelihood_ratio, 2)} · rel {num(c.reliability, 2)} · {c.bundle}
                        </span>
                      </div>
                      <p className="mb-1.5 text-xs leading-snug text-ink-200">{c.evidence}</p>
                      <PathChain path={c.path} onPick={pick} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-ink-400">No evidence path supports the leading hypothesis.</p>
              )}
            </section>

            <section>
              <H>Contradictions ({r.contradictions.length})</H>
              {r.contradictions.length ? (
                <ul className="space-y-2">
                  {r.contradictions.map((k) => {
                    const path = r.contradiction_paths.find((p) => p.contradiction_id === k.id);
                    return (
                      <li key={k.id} className="rounded-md border border-contra/30 bg-contra/5 p-2.5">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="font-mono text-contra">{k.id}</span>
                          <Badge color="#f05252">{k.status}</Badge>
                          <span className="text-ink-400">rule {k.rule} · {humanize(k.type)}</span>
                        </div>
                        <p className="text-xs leading-snug text-ink-100">{k.description}</p>
                        <p className="mt-0.5 text-[11px] text-ink-300">{k.status_reason}</p>
                        {path && (
                          <div className="mt-1.5">
                            <PathChain path={path.path} onPick={pick} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-ink-400">None detected.</p>
              )}
            </section>

            <section>
              <H>Investigation history</H>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                    <th className="pb-1 pr-2 font-medium">#</th>
                    <th className="pb-1 pr-2 font-medium">Action</th>
                    <th className="pb-1 pr-2 font-medium">Outcome</th>
                    <th className="pb-1 pr-2 text-right font-medium">Cost</th>
                    <th className="pb-1 font-medium">By</th>
                  </tr>
                </thead>
                <tbody>
                  {r.investigation_history.map((h) => (
                    <tr key={h.seq} className="border-t border-board-700 align-top">
                      <td className="py-1.5 pr-2 font-mono text-ink-400">{h.seq}</td>
                      <td className="py-1.5 pr-2 text-ink-100">{h.action}</td>
                      <td className="py-1.5 pr-2 text-ink-300">{h.outcome}</td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-200">{h.cost}</td>
                      <td className="py-1.5 font-mono text-ink-400">{h.policy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <div className="space-y-5">
            <section>
              <H>Suspect ranking</H>
              <ol className="space-y-2">
                {r.suspect_ranking.map((s, i) => (
                  <li key={s.hypothesis}>
                    <div className="mb-0.5 flex justify-between gap-2 text-sm">
                      <span className={i === 0 ? "font-semibold text-ink-100" : "text-ink-200"}>
                        {i + 1}. {s.person}
                      </span>
                      <span className="font-mono tabular-nums text-ink-100">{pct(s.probability, 1)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-board-700">
                      <div className="h-full rounded-full" style={{ width: `${s.probability * 100}%`, backgroundColor: i === 0 ? "#a78bfa" : "#6c5aa6" }} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-400">
                      {s.hypothesis} · {s.description}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="grid grid-cols-2 gap-2">
              <Kpi label="Total cost" value={`${r.total_cost} / ${r.budget}`} />
              <Kpi label="Actions taken" value={String(r.actions_taken)} />
              <Kpi label="Remaining entropy" value={bits(r.remaining_uncertainty.entropy_bits, 2)} />
              <Kpi label="Graph version" value={`v${r.graph_version}`} />
            </section>

            <section>
              <H>Remaining uncertainty</H>
              <ul className="space-y-1 text-xs text-ink-200">
                {r.remaining_uncertainty.runner_up && (
                  <li>
                    Runner-up {r.remaining_uncertainty.runner_up.hypothesis} at {pct(r.remaining_uncertainty.runner_up.probability, 1)}
                  </li>
                )}
                {r.remaining_uncertainty.unresolved_contradictions.map((d, i) => (
                  <li key={i} className="text-[#fdba74]">Unresolved: {d}</li>
                ))}
                {r.remaining_uncertainty.unexplored_actions.map((a) => (
                  <li key={a.action_id}>
                    Unexplored: {a.label} <span className="font-mono text-ink-400">(EIG {num(a.eig)})</span>
                  </li>
                ))}
                {!r.remaining_uncertainty.unresolved_contradictions.length && !r.remaining_uncertainty.unexplored_actions.length && (
                  <li className="text-ink-400">No unresolved contradictions or eligible unexplored actions.</li>
                )}
              </ul>
            </section>

            <section>
              <H>Supporting bundles</H>
              <div className="flex flex-wrap gap-1">
                {Object.keys(r.supporting_bundles.counted).map((b) => (
                  <Badge key={b} color="#34d399">{b}</Badge>
                ))}
                {Object.keys(r.supporting_bundles.discounted).map((b) => (
                  <Badge key={b} color="#7f8aa0" className="line-through">{b}</Badge>
                ))}
                {!Object.keys(r.supporting_bundles.counted).length && <span className="text-xs text-ink-400">None.</span>}
              </div>
            </section>

            <section className="rounded-lg border border-board-600 bg-board-850 p-3">
              <H>Simulator ground truth</H>
              {!gt || gt.sealed ? (
                <p className="text-xs text-ink-400">{gt?.note ?? "Sealed until the case is closed."}</p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    <Badge color={gt.correct_solve ? "#34d399" : "#f05252"}>{gt.correct_solve ? "correct solve" : "not a correct solve"}</Badge>
                    <Badge color={gt.leading_matches_truth ? "#34d399" : "#fb923c"}>
                      leading {gt.leading_matches_truth ? "matches" : "does not match"} truth
                    </Badge>
                    <Badge color="#9aa3b2">truth {gt.truth}</Badge>
                    <Badge color="#9aa3b2">variant {gt.variant} · {gt.mode}</Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-200">{gt.narrative}</p>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">{children}</h3>;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-board-800 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="font-mono text-base tabular-nums text-ink-100">{value}</div>
    </div>
  );
}
