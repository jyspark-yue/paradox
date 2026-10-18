import type { Investigation } from "../state/useInvestigation";
import { phaseOf } from "../lib/format";
import { Button, Meter, cx } from "./ui";

const PHASE_STYLE: Record<string, string> = {
  Idle: "text-ink-300 bg-board-700/60 ring-board-500",
  Investigating: "text-evidence bg-evidence/10 ring-evidence/50",
  Solved: "text-action bg-action/10 ring-action/50",
  Inconclusive: "text-[#fb923c] bg-[#fb923c]/10 ring-[#fb923c]/50",
};

export default function TopBar({ inv }: { inv: Investigation }) {
  const { state, cases, caseId } = inv;
  const running = inv.autoRunning || inv.streaming;
  const phase = phaseOf(state, running);
  const closed = state && state.status !== "open";

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-board-700 bg-board-900 px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-serif text-2xl font-bold tracking-tight text-ink-100">Paradox</span>
        <span className="hidden text-[11px] uppercase tracking-[0.18em] text-ink-400 2xl:inline">autonomous detective</span>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink-400">Case</span>
        <select
          className="rounded-md border border-board-600 bg-board-800 px-2 py-1 text-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-evidence/70"
          value={caseId}
          onChange={(e) => void inv.loadCase(e.target.value)}
          disabled={!cases.length}
        >
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.title}
            </option>
          ))}
          {!cases.length && <option value={caseId}>{caseId}</option>}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", PHASE_STYLE[phase])}>
          {running && <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-current" />}
          {phase}
        </span>
        {state && <span className="hidden text-xs text-ink-400 xl:inline">{state.simulation}</span>}
      </div>

      <div className="flex min-w-[180px] items-center gap-2">
        <span className="text-xs text-ink-400">Budget</span>
        <Meter value={state?.spent ?? 0} max={state?.budget ?? 1} className="w-24" color={state && state.spent / state.budget > 0.8 ? "#f05252" : "#e3b341"} />
        <span className="font-mono text-xs tabular-nums text-ink-200">
          {state ? `${state.spent}/${state.budget}` : "—"}
        </span>
        <span className="font-mono text-xs tabular-nums text-ink-400" title="actions taken / maximum actions">
          {state ? `${state.actions_taken}/${state.max_actions} actions` : ""}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-ink-400">Graph</span>
        <span className="rounded bg-board-800 px-1.5 py-0.5 font-mono tabular-nums text-ink-100">v{state?.graph_version ?? "—"}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {inv.busy && <span className="text-xs text-ink-400">{inv.busy}…</span>}
        {closed && inv.report && (
          <Button tone="success" size="sm" onClick={() => inv.setReportOpen(true)}>
            View case report
          </Button>
        )}
        <Button tone="danger" size="sm" onClick={() => void inv.reset()} title="Restart this case with the selected variant and perturbations">
          Reset
        </Button>
      </div>
    </header>
  );
}
