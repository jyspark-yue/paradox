import { useCallback, useEffect, useState } from "react";
import CaseFile from "./components/CaseFile";
import GraphPanel from "./components/GraphPanel";
import Reasoning from "./components/Reasoning";
import ReportModal from "./components/ReportModal";
import Timeline from "./components/Timeline";
import TopBar from "./components/TopBar";
import { useInvestigation } from "./state/useInvestigation";

export default function App() {
  const inv = useInvestigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);

  // Clear the selection when the session changes (case switch / restart).
  const session = inv.state?.session_id;
  useEffect(() => setSelectedId(null), [session]);

  const select = useCallback((id: string | null) => setSelectedId((cur) => (id !== null && cur === id ? null : id)), []);
  const pick = useCallback((id: string) => setSelectedId(id), []);

  const { notice, clearNotice } = inv;
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(clearNotice, 5000);
    return () => window.clearTimeout(t);
  }, [notice, clearNotice]);

  return (
    <div className="flex min-h-screen flex-col bg-board-950 text-ink-100 xl:h-screen xl:min-h-0">
      <TopBar inv={inv} />

      {(inv.error || inv.notice) && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(460px,calc(100%-2rem))] flex-col gap-2">
          {inv.error && (
            <div role="alert" className="pointer-events-auto flex items-start gap-3 rounded-md border border-contra/60 bg-[#2a1214] px-3 py-2 text-sm text-[#fecaca] shadow-xl">
              <span className="flex-1">{inv.error}</span>
              <button type="button" className="text-xs font-semibold underline" onClick={inv.clearError}>
                dismiss
              </button>
            </div>
          )}
          {inv.notice && (
            <div className="pointer-events-auto flex items-start gap-3 rounded-md border border-board-500 bg-board-800 px-3 py-2 text-sm text-ink-100 shadow-xl">
              <span className="flex-1">{inv.notice}</span>
              <button type="button" className="text-xs text-ink-300 underline" onClick={clearNotice}>
                ok
              </button>
            </div>
          )}
        </div>
      )}

      <main className="grid flex-1 grid-cols-1 gap-px bg-board-700 md:grid-cols-2 xl:min-h-0 xl:grid-cols-[296px,minmax(0,1fr),330px] 2xl:grid-cols-[330px,minmax(0,1fr),370px] xl:grid-rows-[minmax(0,1fr),236px]">
        <aside className="order-2 bg-board-900 md:max-h-[880px] xl:order-none xl:max-h-none xl:min-h-0">
          <CaseFile inv={inv} manualMode={manualMode} setManualMode={setManualMode} onSelectNode={pick} selectedId={selectedId} />
        </aside>
        <section className="order-1 h-[640px] bg-board-950 md:col-span-2 xl:order-none xl:col-span-1 xl:h-auto xl:min-h-0">
          <GraphPanel inv={inv} selectedId={selectedId} onSelect={select} />
        </section>
        <aside className="order-3 bg-board-900 md:max-h-[880px] xl:order-none xl:max-h-none xl:min-h-0">
          <Reasoning inv={inv} onSelectNode={pick} />
        </aside>
        <section className="order-4 h-[250px] bg-board-900 md:col-span-2 xl:order-none xl:col-span-3 xl:h-auto xl:min-h-0">
          <Timeline inv={inv} />
        </section>
      </main>

      {inv.reportOpen && inv.report && <ReportModal report={inv.report} onClose={() => inv.setReportOpen(false)} onPick={pick} />}
    </div>
  );
}
