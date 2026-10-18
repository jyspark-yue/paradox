import type { Belief, Decision } from "../api/types";
import type { Investigation } from "../state/useInvestigation";
import { bits, humanize, num, pct } from "../lib/format";
import { Badge, Meter, PathChain, Section, cx } from "./ui";

interface Props {
  inv: Investigation;
  onSelectNode: (id: string) => void;
}

const K_STATUS_COLOR: Record<string, string> = {
  supported: "#f05252",
  unresolved: "#fb923c",
  explained: "#2dd4bf",
  refuted: "#7f8aa0",
};

export default function Reasoning({ inv, onSelectNode }: Props) {
  const { state, actions, replaySeq } = inv;
  const decisions = state?.decisions ?? [];
  const replay = replaySeq !== null ? decisions.find((d) => d.seq === replaySeq) ?? null : null;
  const latest = [...decisions].reverse().find((d) => d.kind === "investigate") ?? null;
  const focusDecision = replay ?? latest;

  // Belief shown: replay step's after-belief, else live posteriors.
  const live: Belief = Object.fromEntries((state?.hypotheses ?? []).map((h) => [h.id, h.posterior]));
  const shown: Belief = replay?.belief_after ?? live;
  const before: Belief | undefined = replay
    ? replay.belief_before
    : (() => {
        const bh = state?.belief_history ?? [];
        return bh.length >= 2 ? bh[bh.length - 2]!.probs : undefined;
      })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-board-700 bg-board-900 px-4 py-3">
        <h2 className="font-serif text-lg font-semibold text-ink-100">Detective Reasoning</h2>
        {replay ? (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md bg-evidence/10 px-2 py-1 text-xs text-evidence ring-1 ring-evidence/40">
            <span>Replaying step {replay.seq}: belief state after this decision</span>
            <button type="button" className="font-semibold underline" onClick={() => inv.setReplaySeq(null)}>
              back to live
            </button>
          </div>
        ) : (
          <p className="mt-0.5 text-xs text-ink-400">Live view · graph v{state?.graph_version ?? "—"}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Hypotheses" right={actions && !replay && <span className="font-mono text-[10.5px] text-ink-400">H = {bits(actions.entropy, 2)}</span>}>
          <ul className="space-y-2.5">
            {(state?.hypotheses ?? [])
              .slice()
              .sort((a, b) => (shown[b.id] ?? 0) - (shown[a.id] ?? 0))
              .map((h) => {
                const p = shown[h.id] ?? 0;
                const b = before?.[h.id];
                const delta = b !== undefined ? p - b : 0;
                const lead = Object.values(shown).every((v) => v <= p);
                return (
                  <li key={h.id}>
                    <button type="button" className="w-full text-left" onClick={() => onSelectNode(h.id)}>
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <span className={cx("text-[13px] leading-snug", lead ? "font-semibold text-ink-100" : "text-ink-200")}>
                          <span className="mr-1 font-mono text-[11px] text-hyp">{h.id}</span>
                          {h.description}
                        </span>
                        <span className="shrink-0 font-mono text-sm tabular-nums text-ink-100">
                          {pct(p, 1)}
                          {Math.abs(delta) >= 0.0005 && (
                            <span className={cx("ml-1 text-[10.5px]", delta > 0 ? "text-action" : "text-contra")}>
                              {delta > 0 ? "+" : "−"}
                              {(Math.abs(delta) * 100).toFixed(1)}
                            </span>
                          )}
                        </span>
                      </div>
                      <Meter value={p} max={1} color={lead ? "#a78bfa" : "#6c5aa6"} marker={state?.confidence_threshold} className="h-2.5" />
                    </button>
                  </li>
                );
              })}
          </ul>
          {state && <p className="mt-2 text-[10.5px] text-ink-400">White tick = stopping threshold {pct(state.confidence_threshold)}. Probabilities are posteriors under the case's explicit likelihood model.</p>}
        </Section>

        <ActivitySection inv={inv} />

        {replay ? <ReplayDecision d={replay} /> : <Recommendation inv={inv} />}

        <StoppingSection inv={inv} replay={replay} />

        <Section title={replay ? `Evidence cited at step ${replay.seq}` : "Evidence citations (latest decision)"}>
          <Citations inv={inv} d={focusDecision} onSelectNode={onSelectNode} />
        </Section>

        <Section title={`Contradictions (${state?.contradictions.length ?? 0})`}>
          {state && state.contradictions.length ? (
            <ul className="space-y-2">
              {state.contradictions.map((k) => (
                <li key={k.id}>
                  <button type="button" className="w-full rounded-md border border-contra/30 bg-contra/5 p-2 text-left hover:border-contra/60" onClick={() => onSelectNode(k.id)}>
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-contra">{k.id}</span>
                      <Badge color={K_STATUS_COLOR[k.status] ?? "#f05252"}>{k.status}</Badge>
                      <span className="text-[10.5px] text-ink-400">
                        rule {k.rule} · {humanize(k.type)}
                      </span>
                    </div>
                    <p className="text-xs leading-snug text-ink-100">{k.description}</p>
                    {k.status_reason && <p className="mt-1 text-[11px] text-ink-300">Why: {k.status_reason}</p>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-400">None detected yet.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function ActivitySection({ inv }: { inv: Investigation }) {
  const a = inv.activity;
  const working = inv.autoRunning || inv.streaming || !!inv.busy;
  return (
    <Section
      title="Agent activity"
      right={
        working ? (
          <span className="flex items-center gap-1.5 text-[11px] text-evidence">
            <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-evidence" />
            {inv.autoRunning ? "autonomous" : inv.streaming ? "streaming run" : "working"}
          </span>
        ) : (
          <span className="text-[11px] text-ink-400">idle</span>
        )
      }
    >
      {!a || (a.phase === "waiting" && !a.entries.length) ? (
        <p className="text-xs text-ink-400">
          {a?.phase === "waiting" ? "Waiting for the agent's next step…" : "No operations yet. Start or step the investigation; each real tool call is listed here as it runs."}
        </p>
      ) : (
        <>
          {a.seq !== null && (
            <p className="mb-1.5 text-[11px] text-ink-400">
              {a.source === "manual" ? "Manual investigation" : `Step ${a.seq}`} · {a.entries.length} tool call{a.entries.length === 1 ? "" : "s"} (hover for tool name)
              {a.phase === "waiting" && " · next step requested…"}
            </p>
          )}
          <ol className="space-y-1">
            {a.entries.map((t, i) => {
              const done = i < a.index || a.phase === "done";
              const current = i === a.index && a.phase === "replaying";
              return (
                <li key={`${t.tool}-${i}`} className={cx("flex items-center gap-2 text-[12.5px] transition-opacity", done ? "text-ink-300" : current ? "text-ink-100" : "text-ink-400 opacity-40")}>
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", !t.ok ? "bg-contra" : current ? "animate-pulseDot bg-evidence" : done ? "bg-action" : "bg-board-500")} />
                  <span className={cx("flex-1", current && "font-semibold")} title={`tool: ${t.tool}${t.error ? ` — ${t.error}` : ""}`}>
                    {t.activity}
                  </span>
                  {t.ms !== undefined && done && <span className="w-12 text-right font-mono text-[10px] tabular-nums text-ink-400">{t.ms} ms</span>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Section>
  );
}

function Recommendation({ inv }: { inv: Investigation }) {
  const { actions, state } = inv;
  if (!actions || !state) return null;
  if (state.status !== "open") {
    return (
      <Section title="Recommendation">
        <p className="text-xs text-ink-300">Investigation closed ({state.status}). {state.status_reason}</p>
      </Section>
    );
  }
  const byId = new Map(actions.candidates.map((c) => [c.action_id, c]));
  const ranked = actions.ranked.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
  const top = ranked[0];
  return (
    <Section title="Recommendation" right={<span className="text-[10.5px] text-ink-400">{actions.objective}</span>}>
      {!top ? (
        <p className="text-xs text-ink-400">No eligible investigation remains.</p>
      ) : (
        <>
          <div className="rounded-md border border-evidence/40 bg-evidence/5 p-2.5">
            <div className="text-[13px] font-semibold text-evidence">{top.label}</div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-ink-300">{top.description}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <Stat label="EIG" value={num(top.eig)} unit="bits" />
              <Stat label="Cost" value={String(top.cost)} />
              <Stat label="Utility" value={num(top.utility)} />
            </div>
            {top.outcome_predictions.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-[10.5px] uppercase tracking-wider text-ink-400">Predicted outcomes</div>
                <ul className="space-y-1">
                  {top.outcome_predictions.map((o) => {
                    const label = top.result_categories.find((r) => r.code === o.code)?.label ?? o.code;
                    return (
                      <li key={o.code} className="text-[11.5px]">
                        <div className="flex justify-between gap-2">
                          <span className="text-ink-200">{label}</span>
                          <span className="font-mono tabular-nums text-ink-300">{pct(o.probability)}</span>
                        </div>
                        <div className="text-[10.5px] text-ink-400">
                          → leads {o.leading_after} at {pct(o.leading_probability)}, H {num(o.posterior_entropy, 2)} bits
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          {ranked.length > 1 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-wider text-ink-400">Runner-ups</div>
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-ink-400">
                    <th className="pb-1 font-medium">#</th>
                    <th className="pb-1 font-medium">Action</th>
                    <th className="pb-1 text-right font-medium">EIG</th>
                    <th className="pb-1 text-right font-medium">Cost</th>
                    <th className="pb-1 text-right font-medium">U</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.slice(1, 5).map((c, i) => (
                    <tr key={c.action_id} className="border-t border-board-700/70">
                      <td className="py-1 pr-1 font-mono text-ink-400">{i + 2}</td>
                      <td className="py-1 pr-2 text-ink-200">{c.label}</td>
                      <td className="py-1 text-right font-mono tabular-nums text-ink-300">{num(c.eig)}</td>
                      <td className="py-1 text-right font-mono tabular-nums text-ink-300">{c.cost}</td>
                      <td className="py-1 text-right font-mono tabular-nums text-ink-100">{num(c.utility)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ReplayDecision({ d }: { d: Decision }) {
  return (
    <Section title={`Decision at step ${d.seq}`} right={<Badge color="#9aa3b2">{d.policy}</Badge>}>
      {d.kind === "conclude" ? (
        <p className="text-xs text-ink-200">Concluded: {d.rationale}</p>
      ) : (
        <>
          <div className="rounded-md border border-evidence/40 bg-evidence/5 p-2.5">
            <div className="text-[13px] font-semibold text-evidence">{d.label}</div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-ink-300">{d.rationale}</p>
            {d.eig !== undefined && (
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <Stat label="EIG" value={num(d.eig)} unit="bits" />
                <Stat label="Cost" value={String(d.cost ?? "—")} />
                <Stat label="Utility" value={num(d.utility)} />
              </div>
            )}
          </div>
          {d.candidates && d.candidates.length > 1 && (
            <table className="mt-2.5 w-full text-[11.5px]">
              <tbody>
                {d.candidates.map((c) => (
                  <tr key={c.action_id} className={cx("border-t border-board-700/70", c.action_id === d.action_id && "text-evidence")}>
                    <td className="py-1 pr-1 font-mono text-ink-400">{c.rank}</td>
                    <td className="py-1 pr-2">{c.label}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{num(c.expected_information_gain)}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{c.cost}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{num(c.utility)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}

function StoppingSection({ inv, replay }: { inv: Investigation; replay: Decision | null }) {
  const { actions, state } = inv;
  if (!state) return null;
  const threshold = state.confidence_threshold;
  const minB = state.min_supporting_bundles;
  if (replay) {
    const s = replay.stopping_before;
    if (!s) return null;
    return (
      <Section title={`Stopping check before step ${replay.seq}`}>
        <StopBody leader={s.leader} confidence={s.confidence} threshold={threshold} bundles={s.supporting_bundles} minB={minB} stop={s.should_stop} reason={s.reason} />
      </Section>
    );
  }
  if (!actions) return null;
  const a = actions.assessment;
  return (
    <Section title="Stopping assessment">
      <StopBody leader={a.leader} confidence={a.confidence} threshold={threshold} bundles={a.supporting_bundles} minB={minB} stop={a.stop} reason={a.reason} />
      {(Object.keys(a.bundles.counted).length > 0 || Object.keys(a.bundles.discounted).length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(a.bundles.counted).map(([b, ids]) => (
            <Badge key={b} color="#34d399" title={ids.join(", ")}>
              {b}
            </Badge>
          ))}
          {Object.entries(a.bundles.discounted).map(([b, ids]) => (
            <Badge key={b} color="#7f8aa0" title={`discounted (undermined by a contradiction): ${ids.join(", ")}`} className="line-through">
              {b}
            </Badge>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10.5px] text-ink-400">
        Best remaining EIG {bits(a.best_eig)} · budget left {a.remaining_budget}
      </p>
    </Section>
  );
}

function StopBody({ leader, confidence, threshold, bundles, minB, stop, reason }: { leader: string; confidence: number; threshold: number; bundles: number; minB: number; stop: boolean; reason: string }) {
  return (
    <>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-ink-300">
          Confidence in <span className="font-mono text-hyp">{leader}</span>
        </span>
        <span className="font-mono tabular-nums text-ink-100">
          {pct(confidence, 1)} / {pct(threshold)}
        </span>
      </div>
      <Meter value={confidence} max={1} marker={threshold} color={confidence >= threshold ? "#34d399" : "#a78bfa"} />
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-ink-300">Independent supporting bundles</span>
        <span className={cx("font-mono tabular-nums", bundles >= minB ? "text-action" : "text-ink-100")}>
          {bundles}/{minB}
        </span>
      </div>
      <div className="mt-1 flex gap-1">
        {Array.from({ length: Math.max(minB, bundles) }).map((_, i) => (
          <span key={i} className={cx("h-1.5 flex-1 rounded-full", i < bundles ? "bg-action" : "bg-board-600")} />
        ))}
      </div>
      <p className={cx("mt-2 text-xs leading-snug", stop ? "text-action" : "text-ink-300")}>
        {stop ? "Stop: " : "Continue: "}
        {reason}
      </p>
    </>
  );
}

function Citations({ inv, d, onSelectNode }: { inv: Investigation; d: Decision | null; onSelectNode: (id: string) => void }) {
  const state = inv.state;
  if (!d || !state) return <p className="text-xs text-ink-400">No decisions yet.</p>;
  const ids = d.evidence_citations?.length ? d.evidence_citations : d.observation?.evidence_id ? [d.observation.evidence_id] : [];
  return (
    <div>
      <p className="mb-1.5 text-[11px] text-ink-400">
        Step {d.seq} · {d.label ?? d.kind} · <span className="font-mono">{d.policy}</span>
      </p>
      <ul className="space-y-1.5">
        {ids.map((id) => {
          const ev = state.evidence.find((e) => e.id === id);
          return (
            <li key={id}>
              <button type="button" className="w-full rounded-md border border-evidence/30 bg-board-850 p-2 text-left hover:border-evidence/60" onClick={() => onSelectNode(id)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-evidence">[{id}]</span>
                  {ev && <span className="font-mono text-[10.5px] text-ink-400">reliability {num(ev.reliability, 2)}</span>}
                </div>
                {ev && (
                  <>
                    <p className="mt-0.5 text-xs leading-snug text-ink-100">{ev.description}</p>
                    <p className="mt-0.5 text-[10.5px] text-ink-400">
                      {ev.provenance} · bundle {ev.bundle}
                    </p>
                  </>
                )}
              </button>
            </li>
          );
        })}
        {!ids.length && <li className="text-xs text-ink-400">No evidence cited.</li>}
      </ul>
      {d.focus && (d.focus.claim_paths.length > 0 || d.focus.record_paths.length > 0) && (
        <div className="mt-2.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wider text-ink-400">
            Graph paths traced (focus {d.focus.hypothesis})
          </div>
          <div className="space-y-1">
            {d.focus.claim_paths.map((p, i) => (
              <div key={`c${i}`} className="flex items-start gap-1.5">
                <span className="mt-0.5 w-12 shrink-0 text-[10px] text-statement">claim</span>
                <PathChain path={p} onPick={onSelectNode} />
              </div>
            ))}
            {d.focus.record_paths.map((p, i) => (
              <div key={`r${i}`} className="flex items-start gap-1.5">
                <span className="mt-0.5 w-12 shrink-0 text-[10px] text-evidence">record</span>
                <PathChain path={p} onPick={onSelectNode} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded bg-board-900/80 px-1 py-1">
      <div className="text-[9.5px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="font-mono text-sm tabular-nums text-ink-100">
        {value}
        {unit && <span className="ml-0.5 text-[9.5px] text-ink-400">{unit}</span>}
      </div>
    </div>
  );
}
