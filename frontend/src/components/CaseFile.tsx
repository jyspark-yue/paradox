import { useMemo, useState } from "react";
import type { ActionCandidate, Policy } from "../api/types";
import type { Investigation } from "../state/useInvestigation";
import { clock, humanize, num, pct } from "../lib/format";
import { Badge, Button, Section, cx } from "./ui";

const POLICY_LABEL: Record<string, string> = {
  eig: "EIG / cost (Bayesian)",
  random: "Random eligible",
  fixed: "Fixed order",
  llm: "LLM agent",
};

interface Props {
  inv: Investigation;
  manualMode: boolean;
  setManualMode: (v: boolean) => void;
  onSelectNode: (id: string) => void;
  selectedId: string | null;
}

export default function CaseFile({ inv, manualMode, setManualMode, onSelectNode, selectedId }: Props) {
  const { state, actions, config, cases, caseId } = inv;
  const caseInfo = cases.find((c) => c.id === caseId);
  const open = state?.status === "open";
  const running = inv.autoRunning || inv.streaming;
  const busy = !!inv.busy;
  const policies: Policy[] = config?.policies ?? ["eig", "random", "fixed"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-board-700 bg-board-900 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-ink-100">Case File</h2>
          <span className="font-mono text-[11px] text-ink-400">{state?.session_id ? `session ${state.session_id}` : ""}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {inv.autoRunning ? (
            <Button tone="primary" onClick={inv.pauseAuto} className="min-w-[150px]">
              Pause investigation
            </Button>
          ) : (
            <Button tone="primary" onClick={inv.startAuto} disabled={!open || busy} className="min-w-[150px]" title="Run the agent step by step until it stops; pausable between steps">
              Start investigation
            </Button>
          )}
          <Button onClick={inv.step} disabled={!open || busy} title="One observe → evaluate → act → update cycle">
            Step
          </Button>
          <Button tone="ghost" onClick={inv.runStream} disabled={!open || busy} title="POST /agent/run: the backend runs the whole loop and streams each step">
            Run to report
          </Button>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-xs text-ink-400">Policy</span>
            <select
              className="rounded-md border border-board-600 bg-board-800 px-2 py-1 text-xs text-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-evidence/70"
              value={inv.policy}
              onChange={(e) => inv.setPolicy(e.target.value as Policy)}
              disabled={running}
            >
              {policies.map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-200" title="Click an eligible investigation below to execute it yourself">
            <input type="checkbox" className="accent-evidence" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} />
            Manual mode
          </label>
          <Button tone="ghost" size="sm" onClick={inv.conclude} disabled={!open || busy} title="POST /conclude: close the case with the current evidence">
            Conclude now
          </Button>
        </div>
        {config && !config.llm_available && (
          <p className="mt-1.5 text-[11px] text-ink-400">LLM policy unavailable: {config.llm_detail}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Incident">
          <h3 className="font-serif text-base font-semibold text-ink-100">{state?.title ?? caseInfo?.title ?? "Loading…"}</h3>
          {state?.window && <p className="mt-0.5 text-xs text-evidence">Window {state.window}</p>}
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-200">{state?.summary ?? caseInfo?.summary}</p>
        </Section>

        <Section title={manualMode ? "Investigations — click to execute" : "Available investigations"} right={actions && <span className="text-[10.5px] text-ink-400">{actions.objective}</span>}>
          <ActionList inv={inv} manualMode={manualMode} onSelectNode={onSelectNode} selectedId={selectedId} />
        </Section>

        <Section title="Suspects">
          <ul className="space-y-2.5">
            {state?.people.map((p) => {
              const h = state.hypotheses.find((x) => x.person_id === p.id);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onSelectNode(p.id)} className={cx("w-full rounded-md border p-2 text-left transition-colors", selectedId === p.id ? "border-person/70 bg-person/10" : "border-board-700 bg-board-850 hover:border-board-600")}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-person">{p.name}</span>
                      {h ? <span className="font-mono text-xs tabular-nums text-hyp">{pct(h.posterior)}</span> : <Badge color="#7f8aa0">not a suspect</Badge>}
                    </div>
                    <div className="text-xs text-ink-300">{p.role}</div>
                    <p className="mt-1 text-xs leading-snug text-ink-200">{p.bio}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.access.map((a) => (
                        <span key={a} className="rounded bg-board-700 px-1.5 py-0.5 text-[10.5px] text-ink-300">
                          {a}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Statements">
          <ul className="space-y-2">
            {state?.statements.map((s) => {
              const contested = state.contradictions.some((k) => k.statement_ids.includes(s.id));
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => onSelectNode(s.id)} className={cx("w-full rounded-md border-l-2 bg-board-850 px-2.5 py-2 text-left hover:bg-board-800", contested ? "border-contra" : "border-statement/60", selectedId === s.id && "ring-1 ring-statement/60")}>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-statement">{s.speaker}</span>
                      <span className="flex items-center gap-1">
                        {contested && <Badge color="#f05252">contradicted</Badge>}
                        {s.revision > 0 && <Badge color="#e3b341">rev {s.revision}</Badge>}
                        <span className="font-mono text-[10.5px] text-ink-400">{s.id}</span>
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-ink-100">“{s.content}”</p>
                    <div className="mt-1 text-[10.5px] text-ink-400">
                      {humanize(s.claim_type)} · {s.source} · recorded {clock(s.recorded_at)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <ScenarioSection inv={inv} />
      </div>
    </div>
  );
}

function ActionList({ inv, manualMode, onSelectNode, selectedId }: { inv: Investigation; manualMode: boolean; onSelectNode: (id: string) => void; selectedId: string | null }) {
  const { actions, state } = inv;
  const [showAll, setShowAll] = useState(true);
  const sorted = useMemo(() => {
    if (!actions) return [] as ActionCandidate[];
    const rank = new Map(actions.ranked.map((id, i) => [id, i]));
    const group = (c: ActionCandidate) => (c.executed ? 2 : c.eligible ? 0 : 1);
    return [...actions.candidates].sort((a, b) => {
      const g = group(a) - group(b);
      if (g) return g;
      if (group(a) === 0) return (rank.get(a.action_id) ?? 99) - (rank.get(b.action_id) ?? 99);
      return b.utility - a.utility;
    });
  }, [actions]);
  if (!actions) return <p className="text-xs text-ink-400">Loading actions…</p>;
  const open = state?.status === "open";
  const remaining = state?.remaining_budget ?? 0;
  const visible = showAll ? sorted : sorted.filter((c) => c.eligible);
  const outcomeFor = (id: string) => state?.observations.find((o) => o.action_id === id);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-3 text-[11px] text-ink-400">
        <span>{actions.candidates.filter((c) => c.eligible).length} eligible · {actions.candidates.filter((c) => c.executed).length} executed</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1">
          <input type="checkbox" className="accent-evidence" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          show ineligible / executed
        </label>
      </div>
      <ul className="space-y-1.5">
        {visible.map((c) => {
          const top = actions.ranked[0] === c.action_id;
          const canRun = manualMode && open && c.eligible && !inv.busy;
          const obs = c.executed ? outcomeFor(c.action_id) : undefined;
          return (
            <li key={c.action_id}>
              <button
                type="button"
                onClick={() => (canRun ? inv.investigate(c.action_id) : onSelectNode(c.action_id))}
                title={canRun ? `Investigate: ${c.label}` : "Show in inspector"}
                className={cx(
                  "group w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                  c.executed ? "border-action/30 bg-action/5" : c.eligible ? "border-board-600 bg-board-850 hover:border-evidence/60" : "border-board-700 bg-board-900 opacity-75",
                  canRun && "cursor-pointer hover:bg-evidence/10",
                  selectedId === c.action_id && "ring-1 ring-evidence/70",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className={cx("text-[13px] font-medium leading-snug", c.executed ? "text-action" : c.eligible ? "text-ink-100" : "text-ink-300")}>{c.label}</span>
                  <span className="shrink-0 rounded bg-board-700 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-200" title="cost">
                    cost {c.cost}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-ink-300">
                  {c.executed ? (
                    <Badge color="#34d399">executed</Badge>
                  ) : c.eligible ? (
                    <>
                      {top && <Badge color="#e3b341">agent's pick</Badge>}
                      {c.rank !== undefined && <span>#{c.rank}</span>}
                      <span title="expected information gain">EIG {num(c.eig)}</span>
                      <span title="EIG ÷ cost">U {num(c.utility)}</span>
                      {c.cost > remaining && <span className="text-contra">over budget</span>}
                    </>
                  ) : (
                    <>
                      <Badge color="#7f8aa0">ineligible</Badge>
                      <span title="expected information gain if it were eligible">EIG {num(c.eig)}</span>
                    </>
                  )}
                  {c.target && <span className="font-sans text-ink-400">→ {c.target}</span>}
                </div>
                {!c.eligible && !c.executed && c.ineligible_reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-[#fca5a5]/90">
                    {c.ineligible_reasons.map((r) => (
                      <li key={r}>— {r}</li>
                    ))}
                  </ul>
                )}
                {obs && <p className="mt-1 text-[11px] leading-snug text-ink-300">Outcome: {obs.outcome_label}</p>}
                {canRun && <span className="mt-1 hidden text-[11px] font-semibold text-evidence group-hover:block">Click to investigate</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScenarioSection({ inv }: { inv: Investigation }) {
  const { state, cases, caseId } = inv;
  const caseInfo = cases.find((c) => c.id === caseId);
  const applied = state?.perturbations ?? [];
  const appliedVariant = /variant\s+([AB])/i.exec(state?.simulation ?? "")?.[1];
  const dirty =
    (appliedVariant && appliedVariant !== inv.variant) ||
    inv.pendingPerturbations.length !== applied.length ||
    inv.pendingPerturbations.some((p) => !applied.includes(p));

  return (
    <Section title="Scenario — prove it's dynamic">
      <p className="mb-2 text-xs leading-snug text-ink-300">
        Change the hidden variant or mutate the case graph, then restart. The agent must re-plan from the new structure.
      </p>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-ink-400">Variant</span>
        <div className="inline-flex overflow-hidden rounded-md border border-board-600">
          {(caseInfo?.variants ?? ["A", "B"]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => inv.setVariant(v as "A" | "B")}
              className={cx("px-3 py-1 text-xs font-semibold", inv.variant === v ? "bg-evidence text-board-950" : "bg-board-800 text-ink-200 hover:bg-board-700")}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-ink-400">running: {appliedVariant ?? "?"}</span>
      </div>
      <ul className="space-y-2">
        {caseInfo?.perturbations.map((p) => {
          const on = inv.pendingPerturbations.includes(p.id);
          const live = applied.includes(p.id);
          return (
            <li key={p.id} className={cx("rounded-md border p-2", on ? "border-evidence/50 bg-evidence/5" : "border-board-700 bg-board-850")}>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-evidence" checked={on} onChange={() => inv.togglePerturbation(p.id)} />
                <span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink-100">
                    {p.label}
                    {live && <Badge color="#34d399">applied</Badge>}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-300">{p.description}</span>
                </span>
              </label>
              {!live && state?.status === "open" && (
                <button type="button" className="ml-6 mt-1 text-[11px] text-ink-400 underline decoration-dotted hover:text-evidence disabled:opacity-40" onClick={() => inv.perturbLive(p.id)} disabled={!!inv.busy}>
                  apply to the live graph now
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <Button tone={dirty ? "primary" : "default"} className="mt-3 w-full" onClick={() => void inv.reset()}>
        {dirty ? "Restart with these settings" : "Restart case"}
      </Button>
    </Section>
  );
}
