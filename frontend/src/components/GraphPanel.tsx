import { useMemo, useState } from "react";
import type { Investigation } from "../state/useInvestigation";
import { DEFAULT_VISIBLE, type GraphFilters, NODE_TYPES, TYPE_META } from "../lib/graphModel";
import EvidenceGraph from "./EvidenceGraph";
import NodeInspector from "./NodeInspector";
import { Button, cx } from "./ui";

interface Props {
  inv: Investigation;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function GraphPanel({ inv, selectedId, onSelect }: Props) {
  const { graph, state, replaySeq } = inv;
  const [types, setTypes] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));
  const [showUnexecutedActions, setShowUnexecuted] = useState(false);
  const [showUndiscoveredEvidence, setShowUndiscovered] = useState(true);
  const [relayoutKey, setRelayoutKey] = useState(0);
  const [fitKey, setFitKey] = useState(0);

  const filters: GraphFilters = useMemo(
    () => ({ types, showUnexecutedActions, showUndiscoveredEvidence }),
    [types, showUnexecutedActions, showUndiscoveredEvidence],
  );

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of graph?.nodes ?? []) c.set(n.type, (c.get(n.type) ?? 0) + 1);
    return c;
  }, [graph]);

  const replayIds = useMemo(() => {
    if (replaySeq === null || !state) return null;
    const d = state.decisions.find((x) => x.seq === replaySeq);
    if (!d) return null;
    const ids = new Set<string>();
    if (d.action_id) ids.add(d.action_id);
    if (d.observation) {
      ids.add(d.observation.id);
      ids.add(d.observation.evidence_id);
    }
    d.evidence_citations?.forEach((id) => ids.add(id));
    d.new_contradictions?.forEach((id) => ids.add(id));
    if (d.kind === "conclude") {
      const lead = state.hypotheses.reduce((a, b) => (b.posterior > a.posterior ? b : a), state.hypotheses[0]!);
      ids.add(lead.id);
      ids.add(lead.person_id);
    }
    return ids;
  }, [replaySeq, state]);

  const toggle = (t: string) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const undiscovered = graph?.nodes.filter((n) => n.type === "Evidence" && !n.properties.discovered).length ?? 0;
  const unexecuted = graph?.nodes.filter((n) => n.type === "InvestigationAction" && !n.properties.executed).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-board-700 bg-board-900 px-3 py-2">
        <h2 className="mr-2 font-serif text-base font-semibold text-ink-100">Evidence Graph</h2>
        {NODE_TYPES.map((t) => {
          const on = types.has(t);
          const meta = TYPE_META[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              aria-pressed={on}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                on ? "border-board-500 bg-board-800 text-ink-100" : "border-board-700 bg-transparent text-ink-400 line-through decoration-ink-400/60",
              )}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color, opacity: on ? 1 : 0.35 }} />
              {meta.label}
              <span className="font-mono text-[10px] text-ink-400">{counts.get(t) ?? 0}</span>
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-board-600" />
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-300">
          <input type="checkbox" className="accent-evidence" checked={showUndiscoveredEvidence} onChange={(e) => setShowUndiscovered(e.target.checked)} />
          undiscovered evidence ({undiscovered})
        </label>
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-300">
          <input type="checkbox" className="accent-evidence" checked={showUnexecutedActions} onChange={(e) => setShowUnexecuted(e.target.checked)} />
          unexecuted actions ({unexecuted})
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" tone="ghost" onClick={() => setFitKey((k) => k + 1)}>
            Fit
          </Button>
          <Button size="sm" tone="ghost" onClick={() => setRelayoutKey((k) => k + 1)}>
            Re-layout
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,#151a26_0%,#0b0d12_75%)]">
        <EvidenceGraph
          graph={graph}
          sessionKey={state?.session_id ?? null}
          filters={filters}
          selectedId={selectedId}
          onSelect={onSelect}
          replayIds={replayIds}
          relayoutKey={relayoutKey}
          fitKey={fitKey}
        />
        {!graph && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-400">
            {inv.error ? "Graph unavailable" : "Loading graph…"}
          </div>
        )}
        <Legend />
        {replaySeq !== null && !selectedId && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-evidence/15 px-2 py-1 text-xs text-evidence ring-1 ring-evidence/40">
            Highlighting nodes touched at step {replaySeq}
          </div>
        )}
        {selectedId && (
          <div className="absolute bottom-3 right-3 top-3 z-10 w-[340px] max-w-[calc(100%-1.5rem)]">
            <NodeInspector inv={inv} nodeId={selectedId} onSelect={onSelect} />
          </div>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-board-700 bg-board-900/85 px-2.5 py-2 text-[10.5px] text-ink-300">
      <div className="flex items-center gap-2">
        <span className="inline-block h-0.5 w-5 bg-contra" /> contradiction (CONTRADICTS / CONFLICTS_WITH / INVOLVES)
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="inline-block h-0.5 w-5 bg-hyp" /> SUPPORTS
        <span className="ml-2 inline-block w-5 border-t border-dashed border-[#6c5aa6]" /> CHALLENGES
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-evidence" /> undiscovered
        <span className="ml-2 inline-block h-2.5 w-2.5 rounded-full ring-2 ring-[#fde68a]" /> new this version
      </div>
    </div>
  );
}
