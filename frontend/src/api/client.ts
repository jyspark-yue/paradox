import type {
  ActionsResponse,
  CaseState,
  CaseSummary,
  Config,
  GraphData,
  HistoryResponse,
  InvestigateResponse,
  Policy,
  Report,
  RunEvent,
  StartRequest,
  StartResponse,
  StepResponse,
} from "./types";

/**
 * Base URL for the Paradox API. With no VITE_API_URL the client calls `/api`, which the Vite
 * dev/preview server proxies to http://localhost:8000 (see vite.config.ts).
 */
const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let detail = res.statusText || `HTTP ${res.status}`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail: unknown }).detail;
      detail = typeof d === "string" ? d : JSON.stringify(d);
    }
  } catch {
    /* body was not JSON */
  }
  return new ApiError(res.status, detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(0, `Cannot reach the Paradox API at ${BASE} (${(e as Error).message})`);
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), signal });

const c = (id: string) => `/cases/${encodeURIComponent(id)}`;

export const api = {
  base: BASE,
  config: () => request<Config>("/config"),
  cases: () => request<CaseSummary[]>("/cases"),
  start: (caseId: string, body: StartRequest) => post<StartResponse>(`${c(caseId)}/start`, body),
  state: (caseId: string) => request<CaseState>(`${c(caseId)}/state`),
  graph: (caseId: string) => request<GraphData>(`${c(caseId)}/graph`),
  actions: (caseId: string) => request<ActionsResponse>(`${c(caseId)}/actions`),
  report: (caseId: string) => request<Report>(`${c(caseId)}/report`),
  history: (caseId: string) => request<HistoryResponse>(`${c(caseId)}/history`),
  investigate: (caseId: string, actionId: string, expectedGraphVersion: number) =>
    post<InvestigateResponse>(`${c(caseId)}/investigate`, {
      action_id: actionId,
      expected_graph_version: expectedGraphVersion,
    }),
  step: (caseId: string, policy: Policy) => post<StepResponse>(`${c(caseId)}/agent/step`, { policy }),
  conclude: (caseId: string) => post<{ status: string; reason: string }>(`${c(caseId)}/conclude`),
  perturb: (caseId: string, perturbationId: string) =>
    post<{ graph_version: number; applied: string }>(`${c(caseId)}/perturb`, { perturbation_id: perturbationId }),

  /**
   * POST /agent/run streams Server-Sent Events. EventSource can't POST, so parse the stream by hand.
   * Calls `onEvent` for each complete event; resolves when the stream ends.
   */
  async run(caseId: string, policy: Policy, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${c(caseId)}/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ policy }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ApiError(0, `Cannot reach the Paradox API at ${BASE} (${(e as Error).message})`);
    }
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) throw new ApiError(0, "Streaming is not supported by this browser");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const dispatch = (block: string) => {
      let event = "message";
      const data: string[] = [];
      for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue;
        const idx = line.indexOf(":");
        const field = idx === -1 ? line : line.slice(0, idx);
        const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (!data.length) return;
      if (event !== "step" && event !== "report" && event !== "halted") return;
      onEvent({ event, data: JSON.parse(data.join("\n")) } as RunEvent);
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatch(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  },
};
