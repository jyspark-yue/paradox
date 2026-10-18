import { useEffect, useRef } from "react";
import type { Decision, HypothesisInfo } from "../api/types";
import type { Investigation } from "../state/useInvestigation";
import { observationText, outcomeLabel, pct } from "../lib/format";
import { Badge, cx } from "./ui";

export default function Timeline({ inv }: { inv: Investigation }) {
  const { state, replaySeq } = inv;
  const decisions = state?.decisions ?? [];
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el && replaySeq === null) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [decisions.length, replaySeq]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-board-700 px-4 py-1.5">
        <h2 className="font-serif text-base font-semibold text-ink-100">Investigation Timeline</h2>
        <span className="text-[11px] text-ink-400">
          {decisions.length ? "Select a card to replay that step's belief state" : ""}
          {replaySeq !== null && (
            <button type="button" className="ml-2 font-semibold text-evidence underline" onClick={() => inv.setReplaySeq(null)}>
              back to live
            </button>
          )}
        </span>
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto overflow-y-hidden px-4 py-2.5">
        {state && (
          <div className="flex w-[180px] shrink-0 flex-col rounded-md border border-board-700 bg-board-850 p-2.5">
            <div className="text-[10.5px] uppercase tracking-wider text-ink-400">Step 0 · prior</div>
            <div className="mt-1 text-[13px] font-medium text-ink-200">Case opened</div>
            <ul className="mt-1.5 space-y-0.5">
              {state.hypotheses.map((h) => (
                <li key={h.id} className="flex justify-between text-[11px]">
                  <span className="text-ink-300">{h.id} {h.person_name.replace(/^Dr\.\s+/, "").split(" ")[0]}</span>
                  <span className="font-mono tabular-nums text-ink-200">{pct(h.prior)}</span>
                </li>
              ))}
            </ul>
            {state.perturbations.length > 0 && (
              <div className="mt-auto pt-1.5 text-[10.5px] leading-snug text-evidence">Perturbed: {state.perturbations.join(", ")}</div>
            )}
          </div>
        )}
        {decisions.map((d) => (
          <Card key={d.seq} d={d} inv={inv} hypotheses={state?.hypotheses ?? []} selected={replaySeq === d.seq} />
        ))}
        {!decisions.length && (
          <div className="flex items-center px-2 text-xs text-ink-400">No investigations yet. Each decision and observation will appear here in order.</div>
        )}
      </div>
    </div>
  );
}

function Card({ d, inv, hypotheses, selected }: { d: Decision; inv: Investigation; hypotheses: HypothesisInfo[]; selected: boolean }) {
  const obs = inv.state?.observations ?? [];
  const toggle = () => inv.setReplaySeq(selected ? null : d.seq);
  const closing = d.kind === "conclude";
  const newK = d.new_contradictions ?? [];
  return (
    <button
      type="button"
      onClick={toggle}
      className={cx(
        "flex w-[300px] shrink-0 animate-slideIn flex-col rounded-md border p-2.5 text-left transition-colors",
        selected ? "overflow-y-auto border-evidence bg-evidence/10" : closing ? "overflow-hidden border-action/40 bg-action/5 hover:border-action/70" : "overflow-hidden border-board-600 bg-board-850 hover:border-board-500",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] uppercase tracking-wider text-ink-400">Step {d.seq}</span>
        <span className="flex items-center gap-1">
          {newK.length > 0 && <Badge color="#f05252">+{newK.length} contradiction{newK.length > 1 ? "s" : ""}</Badge>}
          <Badge color={d.policy === "manual" ? "#5b9cf5" : "#9aa3b2"}>{d.policy}</Badge>
        </span>
      </div>
      {closing ? (
        <>
          <div className="mt-1 text-[13px] font-semibold text-action">Case closed</div>
          <p className={cx("mt-1 text-[11.5px] leading-snug text-ink-200", !selected && "line-clamp-5")}>{d.explanation}</p>
        </>
      ) : (
        <>
          <div className="mt-1 flex items-start justify-between gap-2">
            <span className="text-[13px] font-semibold leading-snug text-ink-100">{d.label}</span>
            {d.cost !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-ink-400">cost {d.cost}</span>}
          </div>
          <div className="mt-0.5 text-[11.5px] text-evidence">{outcomeLabel(d, obs)}</div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-300" title={observationText(d, obs)}>
            <span className="font-mono text-[10.5px] text-ink-400">[{d.observation?.evidence_id}]</span> {observationText(d, obs)}
          </p>
          {d.belief_before && d.belief_after && (
            <table className="mt-1.5 w-full text-[11px]">
              <tbody>
                {hypotheses.map((h) => {
                  const b = d.belief_before?.[h.id] ?? 0;
                  const a = d.belief_after?.[h.id] ?? 0;
                  const up = a - b;
                  return (
                    <tr key={h.id}>
                      <td className="pr-1 font-mono text-hyp">{h.id}</td>
                      <td className="w-full pr-2">
                        <div className="relative h-1.5 rounded-full bg-board-700">
                          <div className="absolute inset-y-0 left-0 rounded-full bg-hyp/40" style={{ width: `${b * 100}%` }} />
                          <div className="absolute inset-y-0 left-0 rounded-full bg-hyp transition-[width] duration-700" style={{ width: `${a * 100}%`, opacity: 0.85 }} />
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right font-mono tabular-nums text-ink-300">
                        {pct(b)} → <span className={cx(up > 0.005 ? "text-action" : up < -0.005 ? "text-contra" : "text-ink-200")}>{pct(a)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className={cx("mt-1.5 text-[11px] leading-snug text-ink-400", !selected && "line-clamp-3")} title={d.explanation}>
            {d.explanation}
          </p>
        </>
      )}
    </button>
  );
}
