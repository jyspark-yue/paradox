import { useMemo, useState, type ReactNode } from "react";
import type { GraphEdge, GraphNode } from "../api/types";
import type { Investigation } from "../state/useInvestigation";
import { TYPE_META, type KnownNodeType, nodeLabel } from "../lib/graphModel";
import { clock, humanize, num, pct } from "../lib/format";
import { Badge, Button, cx } from "./ui";

interface Props {
  inv: Investigation;
  nodeId: string;
  onSelect: (id: string | null) => void;
}

const s = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

export default function NodeInspector({ inv, nodeId, onSelect }: Props) {
  const { graph, state, actions } = inv;
  const [raw, setRaw] = useState(false);

  const index = useMemo(() => {
    const nodes = new Map<string, GraphNode>((graph?.nodes ?? []).map((n) => [n.id, n]));
    const names = new Map<string, string>();
    for (const n of graph?.nodes ?? []) if (n.type === "Person") names.set(n.id, s(n.properties.name));
    return { nodes, names };
  }, [graph]);

  const node = index.nodes.get(nodeId);
  if (!graph || !state) return null;
  const color = TYPE_META[(node?.type as KnownNodeType) ?? "Event"]?.color ?? "#9aa3b2";
  const p = node?.properties ?? {};
  const out = graph.edges.filter((e) => e.source === nodeId);
  const inc = graph.edges.filter((e) => e.target === nodeId);
  const labelOf = (id: string) => {
    const n = index.nodes.get(id);
    return n ? nodeLabel(n, index.names).replace(/\n/g, " ") : id;
  };
  const Link = ({ id, children }: { id: string; children?: ReactNode }) => (
    <button type="button" className="text-left text-ink-100 underline decoration-board-500 decoration-dotted underline-offset-2 hover:text-evidence" onClick={() => onSelect(id)}>
      {children ?? labelOf(id)}
    </button>
  );

  let body: ReactNode = null;
  const action = actions?.candidates.find((c) => c.action_id === nodeId);

  if (!node && !action) {
    body = <p className="text-xs text-ink-400">This node is not in the visible graph.</p>;
  } else if (node?.type === "Contradiction" || state.contradictions.some((k) => k.id === nodeId)) {
    const k = state.contradictions.find((x) => x.id === nodeId);
    const sides = out.filter((e) => e.type === "INVOLVES" || e.type === "CONFLICTS_WITH").map((e) => e.target);
    const between = out.filter((e) => e.type === "BETWEEN").map((e) => e.target);
    body = (
      <>
        <Field label="Why they conflict">
          <p className="text-[12.5px] leading-snug text-ink-100">{k?.description ?? s(p.description)}</p>
        </Field>
        <div className="flex flex-wrap gap-1.5">
          <Badge color="#f05252">{k?.status ?? s(p.status)}</Badge>
          <Badge color="#9aa3b2">rule {k?.rule ?? s(p.rule)}</Badge>
          <Badge color="#9aa3b2">{humanize(k?.type ?? s(p.contradiction_type))}</Badge>
          {p.travel_minutes !== undefined && <Badge color="#9aa3b2">travel {s(p.travel_minutes)} min · gap {s(p.gap_minutes)} min</Badge>}
        </div>
        <Field label="Status reason">
          <p className="text-xs text-ink-200">{k?.status_reason ?? s(p.status_reason)}</p>
        </Field>
        <Field label="Conflicting claims">
          <ul className="space-y-1.5">
            {sides.map((id) => {
              const n = index.nodes.get(id);
              const text = n?.type === "Statement" ? `“${s(n.properties.content)}”` : s(n?.properties.description);
              return (
                <li key={id} className="rounded border-l-2 border-contra bg-board-900 px-2 py-1.5 text-xs">
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <Badge color={n?.type === "Statement" ? "#2dd4bf" : "#e3b341"}>{n?.type ?? "node"}</Badge>
                    <Link id={id}>{id}</Link>
                    {n?.type === "Statement" && <span className="text-ink-400">by {index.names.get(s(n.properties.speaker_id)) ?? s(n.properties.speaker_id)}</span>}
                  </div>
                  <p className="leading-snug text-ink-100">{text}</p>
                </li>
              );
            })}
          </ul>
        </Field>
        {between.length > 0 && (
          <Field label="Placements compared">
            <ul className="space-y-0.5 text-xs">
              {between.map((id) => (
                <li key={id}>
                  <Link id={id} />
                </li>
              ))}
            </ul>
          </Field>
        )}
        {(k?.explained_evidence || k?.losing_evidence) && (
          <Field label="Resolution">
            {k.explained_evidence && <p className="text-xs text-ink-200">Explained by {k.explained_evidence}</p>}
            {k.losing_evidence && <p className="text-xs text-ink-200">Losing evidence: {k.losing_evidence}</p>}
          </Field>
        )}
      </>
    );
  } else if (node?.type === "Hypothesis") {
    const h = state.hypotheses.find((x) => x.id === nodeId);
    const supports = inc.filter((e) => e.type === "SUPPORTS");
    const challenges = inc.filter((e) => e.type === "CHALLENGES");
    body = (
      <>
        <p className="text-[13px] text-ink-100">{s(p.description)}</p>
        <div className="grid grid-cols-2 gap-2">
          <Mini label="Prior" value={pct(Number(p.prior_probability), 1)} />
          <Mini label="Posterior" value={pct(h?.posterior ?? Number(p.posterior_probability), 1)} />
        </div>
        <EvidenceList title={`Supporting evidence (${supports.length})`} edges={supports} tone="#34d399" index={index} Link={Link} />
        <EvidenceList title={`Challenging evidence (${challenges.length})`} edges={challenges} tone="#f05252" index={index} Link={Link} />
      </>
    );
  } else if (node?.type === "InvestigationAction" || action) {
    const obs = state.observations.find((o) => o.action_id === nodeId);
    body = (
      <>
        <p className="text-[12.5px] leading-snug text-ink-200">{action?.description ?? s(p.description)}</p>
        <div className="grid grid-cols-3 gap-2">
          <Mini label="Cost" value={String(action?.cost ?? s(p.cost))} />
          <Mini label="EIG" value={action ? num(action.eig) : "—"} />
          <Mini label="Utility" value={action ? num(action.utility) : "—"} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {action?.executed || p.executed ? (
            <Badge color="#34d399">executed</Badge>
          ) : action?.eligible ? (
            <Badge color="#e3b341">available{action.rank ? ` · rank ${action.rank}` : ""}</Badge>
          ) : (
            <Badge color="#7f8aa0">unavailable</Badge>
          )}
          {action?.target && <Badge color="#5b9cf5">target {action.target}</Badge>}
          {action?.location && <Badge color="#64748b">{action.location}{action.distance_from_scene !== null ? ` · ${action.distance_from_scene} hop${action.distance_from_scene === 1 ? "" : "s"} from scene` : ""}</Badge>}
        </div>
        {action && !action.eligible && action.ineligible_reasons.length > 0 && (
          <Field label="Why unavailable">
            <ul className="text-xs text-[#fca5a5]">
              {action.ineligible_reasons.map((r) => (
                <li key={r}>— {r}</li>
              ))}
            </ul>
          </Field>
        )}
        {obs && (
          <Field label={`Observed (step ${obs.seq})`}>
            <p className="text-xs text-evidence">{obs.outcome_label}</p>
            <p className="text-xs leading-snug text-ink-200">{obs.evidence_description}</p>
          </Field>
        )}
        {action && !action.executed && action.outcome_predictions.length > 0 && (
          <Field label="Predicted outcomes">
            <ul className="space-y-0.5 text-xs">
              {action.outcome_predictions.map((o) => (
                <li key={o.code} className="flex justify-between gap-2">
                  <span className="text-ink-200">{action.result_categories.find((r) => r.code === o.code)?.label ?? o.code}</span>
                  <span className="font-mono tabular-nums text-ink-300">{pct(o.probability)}</span>
                </li>
              ))}
            </ul>
          </Field>
        )}
        {action && action.prerequisites.length > 0 && <Field label="Prerequisites"><p className="font-mono text-xs text-ink-300">{action.prerequisites.join(", ")}</p></Field>}
        {action && Object.keys(action.conditioned_on).length > 0 && (
          <Field label="Likelihood conditioned on">
            <p className="font-mono text-xs text-ink-300">{Object.entries(action.conditioned_on).map(([a, c]) => `${a}=${c}`).join(", ")}</p>
          </Field>
        )}
        {action && inv.state?.status === "open" && action.eligible && !action.executed && (
          <Button tone="primary" size="sm" disabled={!!inv.busy} onClick={() => inv.investigate(action.action_id)}>
            Investigate manually (cost {action.cost})
          </Button>
        )}
      </>
    );
  } else if (node?.type === "Evidence") {
    const effects = out.filter((e) => e.type === "SUPPORTS" || e.type === "CHALLENGES");
    const claims = out.filter((e) => e.type === "CONTRADICTS" || e.type === "CORROBORATES" || e.type === "EXPLAINS");
    body = (
      <>
        {p.discovered ? (
          <p className="text-[12.5px] leading-snug text-ink-100">{s(p.description)}</p>
        ) : (
          <p className="text-xs italic text-ink-400">Not yet discovered. Its content is hidden until an investigation reveals it.</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Mini label="Reliability" value={p.discovered ? num(Number(p.reliability), 2) : "—"} />
          <Mini label="Bundle" value={s(p.bundle) || "—"} />
        </div>
        {!!p.provenance && <Field label="Provenance"><p className="text-xs text-ink-200">{s(p.provenance)}</p></Field>}
        {effects.length > 0 && (
          <Field label="Effect on hypotheses (likelihood ratio)">
            <ul className="space-y-0.5 text-xs">
              {effects.map((e) => (
                <li key={e.target + e.type} className="flex justify-between gap-2">
                  <span>
                    <span className={e.type === "SUPPORTS" ? "text-action" : "text-contra"}>{e.type.toLowerCase()}</span> <Link id={e.target}>{e.target}</Link>
                  </span>
                  <span className="font-mono tabular-nums text-ink-300">×{num(Number(e.props.weight), 2)}</span>
                </li>
              ))}
            </ul>
          </Field>
        )}
        {claims.length > 0 && (
          <Field label="Bearing on statements">
            <ul className="space-y-0.5 text-xs">
              {claims.map((e) => (
                <li key={e.target + e.type}>
                  <span className={e.type === "CONTRADICTS" ? "text-contra" : "text-action"}>{e.type.toLowerCase()}</span> <Link id={e.target} />
                </li>
              ))}
            </ul>
          </Field>
        )}
      </>
    );
  } else if (node?.type === "Person") {
    const person = state.people.find((x) => x.id === nodeId);
    const statements = state.statements.filter((x) => x.speaker_id === nodeId);
    const h = state.hypotheses.find((x) => x.person_id === nodeId);
    body = (
      <>
        <p className="text-xs text-ink-300">{person?.role ?? s(p.role)}</p>
        <p className="text-[12.5px] leading-snug text-ink-100">{person?.bio ?? s(p.bio)}</p>
        {h && <Mini label={`${h.id} posterior`} value={pct(h.posterior, 1)} />}
        {person && (
          <Field label="Access">
            <div className="flex flex-wrap gap-1">
              {person.access.map((a) => (
                <span key={a} className="rounded bg-board-700 px-1.5 py-0.5 text-[10.5px] text-ink-300">{a}</span>
              ))}
            </div>
          </Field>
        )}
        {statements.length > 0 && (
          <Field label="Statements">
            <ul className="space-y-1 text-xs">
              {statements.map((st) => (
                <li key={st.id} className="leading-snug text-ink-100">
                  <Link id={st.id}>{st.id}</Link>: “{st.content}”
                </li>
              ))}
            </ul>
          </Field>
        )}
      </>
    );
  } else if (node?.type === "Statement") {
    const challenged = inc.filter((e) => e.type === "CONTRADICTS");
    const corroborated = inc.filter((e) => e.type === "CORROBORATES");
    body = (
      <>
        <p className="text-xs text-ink-300">by <Link id={s(p.speaker_id)}>{index.names.get(s(p.speaker_id)) ?? s(p.speaker_id)}</Link> · {humanize(s(p.claim_type))} · recorded {clock(Number(p.recorded_at))}</p>
        <p className="text-[13px] leading-snug text-ink-100">“{s(p.content)}”</p>
        {challenged.length > 0 && (
          <Field label="Contradicted by">
            <ul className="text-xs">{challenged.map((e) => <li key={e.source}><Link id={e.source} /></li>)}</ul>
          </Field>
        )}
        {corroborated.length > 0 && (
          <Field label="Corroborated by">
            <ul className="text-xs">{corroborated.map((e) => <li key={e.source}><Link id={e.source} /></li>)}</ul>
          </Field>
        )}
      </>
    );
  } else if (node?.type === "Event") {
    body = (
      <>
        <p className="text-[12.5px] text-ink-100">{s(p.description)}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge color={p.status === "recorded" ? "#e3b341" : "#9aa3b2"}>{s(p.status)}</Badge>
          <Badge color="#9aa3b2">{humanize(s(p.event_type))}</Badge>
          <Badge color="#9aa3b2">{clock(Number(p.time_start))} – {clock(Number(p.time_end))}</Badge>
        </div>
      </>
    );
  } else if (node) {
    body = <p className="text-[12.5px] text-ink-100">{s(p.description) || s(p.outcome_label) || s(p.name) || node.id}</p>;
  }

  const rels = [...out.map((e) => ({ e, dir: "out" as const, other: e.target })), ...inc.map((e) => ({ e, dir: "in" as const, other: e.source }))];

  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-lg border border-board-600 bg-board-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-2 border-b border-board-700 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge color={color}>{node?.type ?? "InvestigationAction"}</Badge>
            <span className="truncate font-mono text-[11px] text-ink-400">{nodeId}</span>
          </div>
          <div className="mt-1 text-sm font-semibold leading-snug text-ink-100">{node ? labelOf(nodeId) : action?.label}</div>
        </div>
        <button type="button" aria-label="Close inspector" className="rounded px-1.5 text-lg leading-none text-ink-400 hover:bg-board-700 hover:text-ink-100" onClick={() => onSelect(null)}>
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {body}
        {rels.length > 0 && (
          <Field label={`Direct relationships (${rels.length})`}>
            <ul className="space-y-0.5 text-[11.5px]">
              {rels.slice(0, 30).map(({ e, dir, other }, i) => (
                <li key={`${e.type}-${other}-${i}`} className="flex items-baseline gap-1.5">
                  <span className={cx("shrink-0 font-mono text-[10px]", ["CONTRADICTS", "CONFLICTS_WITH", "INVOLVES"].includes(e.type) ? "text-contra" : "text-ink-400")}>
                    {dir === "out" ? `${e.type} →` : `← ${e.type}`}
                  </span>
                  <Link id={other} />
                </li>
              ))}
            </ul>
          </Field>
        )}
        {node && (
          <div>
            <button type="button" className="text-[11px] text-ink-400 underline decoration-dotted hover:text-ink-200" onClick={() => setRaw((r) => !r)}>
              {raw ? "hide" : "show"} raw properties
            </button>
            {raw && (
              <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
                {Object.entries(p).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-400">{k}</dt>
                    <dd className="break-words text-ink-200">{s(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      {children}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-board-800 px-2 py-1">
      <div className="text-[9.5px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="truncate font-mono text-[13px] tabular-nums text-ink-100">{value}</div>
    </div>
  );
}

function EvidenceList({
  title,
  edges,
  tone,
  index,
  Link,
}: {
  title: string;
  edges: GraphEdge[];
  tone: string;
  index: { nodes: Map<string, GraphNode> };
  Link: (p: { id: string; children?: ReactNode }) => JSX.Element;
}) {
  return (
    <Field label={title}>
      {edges.length ? (
        <ul className="space-y-1">
          {edges.map((e) => {
            const n = index.nodes.get(e.source);
            return (
              <li key={e.source} className="rounded border-l-2 bg-board-800 px-2 py-1 text-xs" style={{ borderColor: tone }}>
                <div className="flex justify-between gap-2">
                  <Link id={e.source}>{e.source}</Link>
                  <span className="font-mono text-[10.5px] text-ink-300">LR ×{num(Number(e.props.weight), 2)}</span>
                </div>
                <p className="leading-snug text-ink-200">{s(n?.properties.description)}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-ink-400">None yet.</p>
      )}
    </Field>
  );
}
