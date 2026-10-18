import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type {
  ActionsResponse,
  CaseState,
  CaseSummary,
  Config,
  Decision,
  GraphData,
  Policy,
  Report,
  StepResponse,
  TraceEntry,
  Variant,
} from "../api/types";

export interface ActivityState {
  /** Where the labels came from: an agent step's trace, or a manual investigation. */
  source: "agent" | "manual";
  entries: TraceEntry[];
  /** Index of the entry currently being shown; entries before it are complete. */
  index: number;
  /** Decision sequence number the entries belong to. */
  seq: number | null;
  /** waiting = request in flight (no labels yet); replaying = walking the real trace; done = finished. */
  phase: "waiting" | "replaying" | "done";
}

const ACTIVITY_MS = 230;
const AUTO_GAP_MS = 650;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseVariant(simulation: string | undefined): Variant | null {
  const m = /variant\s+([AB])/i.exec(simulation ?? "");
  return m ? (m[1]!.toUpperCase() as Variant) : null;
}

export function useInvestigation() {
  const [config, setConfig] = useState<Config | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [caseId, setCaseId] = useState("case001");
  const [variant, setVariant] = useState<Variant>("A");
  const [pendingPerturbations, setPendingPerturbations] = useState<string[]>([]);
  const [policy, setPolicy] = useState<Policy>("eig");

  const [state, setState] = useState<CaseState | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [actions, setActions] = useState<ActionsResponse | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState | null>(null);
  const [replaySeq, setReplaySeq] = useState<number | null>(null);

  const caseRef = useRef(caseId);
  const stateRef = useRef<CaseState | null>(null);
  const autoRef = useRef(false);
  const busyRef = useRef(false);
  const genRef = useRef(0); // bumps on reset / case switch; stale async work checks it and bails
  const streamAbort = useRef<AbortController | null>(null);

  stateRef.current = state;

  const fail = useCallback((e: unknown) => {
    if ((e as Error)?.name === "AbortError") return;
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  /** Fetch state, graph, actions (and the report once the case is closed) for the current case. */
  const refresh = useCallback(
    async (opts: { openReportOnClose?: boolean } = {}) => {
      const id = caseRef.current;
      const gen = genRef.current;
      const prevStatus = stateRef.current?.status;
      const [st, gr, ac] = await Promise.all([api.state(id), api.graph(id), api.actions(id)]);
      if (gen !== genRef.current || id !== caseRef.current) return null;
      setState(st);
      stateRef.current = st;
      setGraph(gr);
      setActions(ac);
      if (st.status !== "open") {
        const rep = await api.report(id);
        if (gen !== genRef.current) return st;
        setReport(rep);
        if (opts.openReportOnClose && prevStatus === "open") setReportOpen(true);
      } else {
        setReport(null);
      }
      return st;
    },
    [],
  );

  const syncSettingsFrom = useCallback((st: CaseState) => {
    const v = parseVariant(st.simulation);
    if (v) setVariant(v);
    setPendingPerturbations(st.perturbations ?? []);
  }, []);

  const stopEverything = useCallback(() => {
    autoRef.current = false;
    setAutoRunning(false);
    streamAbort.current?.abort();
    streamAbort.current = null;
    setStreaming(false);
    genRef.current += 1;
    busyRef.current = false;
    setBusy(null);
  }, []);

  /** Load a case; start it with default settings if the backend has no session yet (GET → 404). */
  const loadCase = useCallback(
    async (id: string) => {
      stopEverything();
      caseRef.current = id;
      setCaseId(id);
      setState(null);
      stateRef.current = null;
      setGraph(null);
      setActions(null);
      setReport(null);
      setReportOpen(false);
      setActivity(null);
      setReplaySeq(null);
      setError(null);
      setNotice(null);
      setBusy("Loading case");
      const gen = genRef.current;
      try {
        try {
          const st = await api.state(id);
          if (gen !== genRef.current) return;
          syncSettingsFrom(st);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
          const started = await api.start(id, { variant: "A", mode: "scripted", seed: 0, perturbations: [] });
          if (gen !== genRef.current) return;
          syncSettingsFrom(started.state);
          setNotice(`Started ${id} (variant A, no perturbations).`);
        }
        await refresh();
      } catch (e) {
        if (gen === genRef.current) fail(e);
      } finally {
        if (gen === genRef.current) setBusy(null);
      }
    },
    [fail, refresh, stopEverything, syncSettingsFrom],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, cs] = await Promise.all([api.config(), api.cases()]);
        if (cancelled) return;
        setConfig(cfg);
        setCases(cs);
        const first = cs.find((c) => c.id === "case001")?.id ?? cs[0]?.id;
        if (first) await loadCase(first);
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Walk through the step's real trace entries so the activity indicator replays them in order. */
  const replayTrace = useCallback(async (trace: TraceEntry[], seq: number | null, gen: number) => {
    if (!trace.length) {
      setActivity(null);
      return;
    }
    for (let i = 0; i < trace.length; i++) {
      if (gen !== genRef.current) return;
      setActivity({ source: "agent", entries: trace, index: i, seq, phase: "replaying" });
      await sleep(ACTIVITY_MS);
    }
    if (gen !== genRef.current) return;
    setActivity({ source: "agent", entries: trace, index: trace.length, seq, phase: "done" });
  }, []);

  /** One agent decision-and-action cycle. Returns true when the agent is done. */
  const stepOnce = useCallback(async (): Promise<boolean> => {
    const gen = genRef.current;
    const id = caseRef.current;
    setActivity((a) => ({
      source: "agent",
      entries: a?.phase === "done" ? [] : a?.entries ?? [],
      index: 0,
      seq: null,
      phase: "waiting",
    }));
    const res: StepResponse = await api.step(id, policy);
    if (gen !== genRef.current) return true;
    await replayTrace(res.trace, res.decision?.seq ?? null, gen);
    if (gen !== genRef.current) return true;
    setReplaySeq(null);
    await refresh({ openReportOnClose: true });
    return res.done;
  }, [policy, refresh, replayTrace]);

  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      const gen = genRef.current;
      try {
        await fn();
      } catch (e) {
        if (gen === genRef.current) {
          fail(e);
          if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
            await refresh().catch(() => undefined);
          }
        }
      } finally {
        if (gen === genRef.current) {
          busyRef.current = false;
          setBusy(null);
        }
      }
    },
    [fail, refresh],
  );

  const step = useCallback(() => guard("Agent step", async () => void (await stepOnce())), [guard, stepOnce]);

  /** Autonomous loop: repeated /agent/step calls, so Pause takes effect between real steps. */
  const startAuto = useCallback(() => {
    if (busyRef.current || autoRef.current) return;
    autoRef.current = true;
    setAutoRunning(true);
    void guard("Autonomous investigation", async () => {
      try {
        while (autoRef.current) {
          const done = await stepOnce();
          if (done || !autoRef.current) break;
          await sleep(AUTO_GAP_MS);
        }
      } finally {
        autoRef.current = false;
        setAutoRunning(false);
      }
    });
  }, [guard, stepOnce]);

  const pauseAuto = useCallback(() => {
    autoRef.current = false;
  }, []);

  /**
   * POST /agent/run (SSE). The backend runs the whole loop; we replay each streamed step's trace,
   * patch beliefs and the timeline as events arrive, then sync the graph from the API at the end.
   */
  const runStream = useCallback(() => {
    void guard("Streaming agent run", async () => {
      const id = caseRef.current;
      const gen = genRef.current;
      const ctrl = new AbortController();
      streamAbort.current = ctrl;
      setStreaming(true);
      let chain = Promise.resolve();
      let finalReport: Report | null = null;
      const applyDecision = (d: Decision) => {
        setState((s) => {
          if (!s) return s;
          const after = d.belief_after;
          return {
            ...s,
            decisions: [...s.decisions.filter((x) => x.seq !== d.seq), d],
            hypotheses: after
              ? s.hypotheses.map((h) => ({ ...h, posterior: after[h.id] ?? h.posterior }))
              : s.hypotheses,
            spent: d.kind === "investigate" && d.cost ? s.spent + d.cost : s.spent,
            actions_taken: d.kind === "investigate" ? Math.max(s.actions_taken, d.seq) : s.actions_taken,
          };
        });
      };
      try {
        setActivity({ source: "agent", entries: [], index: 0, seq: null, phase: "waiting" });
        await api.run(
          id,
          policy,
          (ev) => {
            chain = chain.then(async () => {
              if (gen !== genRef.current) return;
              if (ev.event === "step") {
                await replayTrace(ev.data.trace, ev.data.decision?.seq ?? null, gen);
                if (ev.data.decision) applyDecision(ev.data.decision);
                await sleep(250);
              } else if (ev.event === "report") {
                finalReport = ev.data;
              } else {
                setError(`Agent halted: ${ev.data.detail}`);
              }
            });
          },
          ctrl.signal,
        );
        await chain;
        if (gen !== genRef.current) return;
        setReplaySeq(null);
        await refresh();
        if (finalReport) {
          setReport(finalReport);
          if ((finalReport as Report).status !== "open") setReportOpen(true);
        }
      } finally {
        if (streamAbort.current === ctrl) streamAbort.current = null;
        setStreaming(false);
      }
    });
  }, [guard, policy, refresh, replayTrace]);

  /** Manual mode: same simulator path as the agent, guarded by the graph version. */
  const investigate = useCallback(
    (actionId: string) =>
      guard("Manual investigation", async () => {
        const st = stateRef.current;
        if (!st) return;
        const cand = actions?.candidates.find((c) => c.action_id === actionId);
        const entry: TraceEntry = {
          tool: "investigate",
          args: { action_id: actionId },
          activity: cand?.activity ?? actionId,
          ok: true,
        };
        setActivity({ source: "manual", entries: [entry], index: 0, seq: null, phase: "replaying" });
        const res = await api.investigate(caseRef.current, actionId, st.graph_version);
        setActivity({ source: "manual", entries: [entry], index: 1, seq: res.observation.seq ?? null, phase: "done" });
        if (res.already_executed) setNotice("Already investigated; no budget charged.");
        setReplaySeq(null);
        await refresh({ openReportOnClose: true });
      }),
    [actions, guard, refresh],
  );

  const conclude = useCallback(
    () =>
      guard("Concluding", async () => {
        await api.conclude(caseRef.current);
        await refresh({ openReportOnClose: true });
      }),
    [guard, refresh],
  );

  const perturbLive = useCallback(
    (pid: string) =>
      guard("Applying perturbation", async () => {
        await api.perturb(caseRef.current, pid);
        setNotice(`Applied "${pid}" to the live graph. The agent re-plans from the changed structure.`);
        await refresh();
      }),
    [guard, refresh],
  );

  /** Restart the current case with the selected variant and perturbations. */
  const reset = useCallback(async () => {
    stopEverything();
    const gen = genRef.current;
    const id = caseRef.current;
    busyRef.current = true;
    setBusy("Restarting case");
    setError(null);
    setActivity(null);
    setReplaySeq(null);
    setReportOpen(false);
    setReport(null);
    try {
      const res = await api.start(id, { variant, mode: "scripted", seed: 0, perturbations: pendingPerturbations });
      if (gen !== genRef.current) return;
      stateRef.current = null;
      syncSettingsFrom(res.state);
      await refresh();
      setNotice(
        `Restarted ${id}: variant ${variant}` +
          (pendingPerturbations.length ? `, perturbations: ${pendingPerturbations.join(", ")}` : ", no perturbations"),
      );
    } catch (e) {
      if (gen === genRef.current) fail(e);
    } finally {
      if (gen === genRef.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }, [fail, pendingPerturbations, refresh, stopEverything, syncSettingsFrom, variant]);

  const togglePerturbation = useCallback((pid: string) => {
    setPendingPerturbations((ps) => (ps.includes(pid) ? ps.filter((p) => p !== pid) : [...ps, pid]));
  }, []);

  return {
    config,
    cases,
    caseId,
    variant,
    setVariant,
    pendingPerturbations,
    togglePerturbation,
    policy,
    setPolicy,
    state,
    graph,
    actions,
    report,
    reportOpen,
    setReportOpen,
    busy,
    autoRunning,
    streaming,
    error,
    clearError: () => setError(null),
    notice,
    clearNotice: () => setNotice(null),
    activity,
    replaySeq,
    setReplaySeq,
    loadCase,
    step,
    startAuto,
    pauseAuto,
    runStream,
    investigate,
    conclude,
    perturbLive,
    reset,
  };
}

export type Investigation = ReturnType<typeof useInvestigation>;
