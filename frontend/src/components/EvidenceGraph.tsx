import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { GraphData } from "../api/types";
import { appearanceSig, type GraphFilters, isNodeVisible, toElements } from "../lib/graphModel";
import { graphStyle } from "../lib/graphStyle";

cytoscape.use(fcose);

interface Props {
  graph: GraphData | null;
  /** Changes when the case is switched or restarted; the canvas is rebuilt from scratch. */
  sessionKey: string | null;
  filters: GraphFilters;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Node ids to emphasise for the timeline replay view; null = live view. */
  replayIds: Set<string> | null;
  /** Increment to force a fresh layout. */
  relayoutKey: number;
  fitKey: number;
}

function layoutOptions(randomize: boolean): LayoutOptions {
  return {
    name: "fcose",
    quality: "default",
    randomize,
    animate: !randomize,
    animationDuration: 550,
    fit: true,
    padding: 36,
    nodeDimensionsIncludeLabels: true,
    nodeRepulsion: 7000,
    idealEdgeLength: 85,
    edgeElasticity: 0.4,
    nodeSeparation: 90,
    gravity: 0.3,
    gravityRange: 3.2,
    numIter: 2500,
    packComponents: true,
    tile: true,
  } as unknown as LayoutOptions;
}

export default function EvidenceGraph({ graph, sessionKey, filters, selectedId, onSelect, replayIds, relayoutKey, fitKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  const sigRef = useRef<Map<string, string> | null>(null);
  const caseKeyRef = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  onSelectRef.current = onSelect;

  // Create the Cytoscape instance once.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: graphStyle,
      elements: [],
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
      autoungrabify: false,
    });
    cy.on("tap", "node", (e) => onSelectRef.current((e.target as NodeSingular).id()));
    cy.on("tap", (e) => {
      if (e.target === cy) onSelectRef.current(null);
    });
    cyRef.current = cy;
    if (import.meta.env.DEV) (window as unknown as { __paradoxCy?: Core }).__paradoxCy = cy; // dev-only debugging hook
    let fitTimer = 0;
    const ro = new ResizeObserver(() => {
      cy.resize();
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        const eles = cy.elements().not(".filtered");
        if (eles.length) cy.fit(eles, 36);
      }, 180);
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      window.clearTimeout(fitTimer);
      timers.current.forEach((t) => window.clearTimeout(t));
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  const applyFilters = (cy: Core) => {
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const visible = isNodeVisible({ type: n.data("type") as string, classes: n.classes() as unknown as string[] }, filters);
        n.toggleClass("filtered", !visible);
      });
      cy.edges().forEach((e) => {
        e.toggleClass("filtered", e.source().hasClass("filtered") || e.target().hasClass("filtered"));
      });
    });
  };

  const runLayout = (cy: Core, randomize: boolean) => {
    const eles = cy.elements().not(".filtered");
    if (!eles.length) return;
    eles.layout(layoutOptions(randomize)).run();
  };

  // Sync graph data → Cytoscape incrementally so positions stay stable between versions.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (!graph) {
      cy.elements().remove();
      sigRef.current = null;
      return;
    }
    const { nodes, edges } = toElements(graph);
    // Case switch / restart → start fresh.
    if (sessionKey !== caseKeyRef.current) {
      cy.elements().remove();
      sigRef.current = null;
      caseKeyRef.current = sessionKey;
    }
    const first = cy.nodes().length === 0;
    const prevSig = sigRef.current;
    const nextSig = new Map(graph.nodes.map((n) => [n.id, appearanceSig(n)]));
    const fresh = new Set<string>();
    if (prevSig) {
      for (const [id, sig] of nextSig) {
        const before = prevSig.get(id);
        if (before === undefined || (before !== sig && sig !== "off")) fresh.add(id);
      }
    }
    sigRef.current = nextSig;

    const wantIds = new Set<string>([...nodes, ...edges].map((e) => e.data.id as string));
    let structural = first;
    cy.batch(() => {
      cy.elements().forEach((el) => {
        if (!wantIds.has(el.id())) {
          el.remove();
          structural = true;
        }
      });
      const addNode = (def: ElementDefinition) => {
        const id = def.data.id as string;
        const existing = cy.getElementById(id);
        if (existing.nonempty()) {
          existing.data(def.data);
          existing.classes(def.classes as string[]);
          return;
        }
        structural = true;
        cy.add({ ...def, position: { x: 0, y: 0 } });
      };
      nodes.forEach(addNode);
      edges.forEach((def) => {
        const existing = cy.getElementById(def.data.id as string);
        if (existing.nonempty()) {
          existing.classes(def.classes as string[]);
          return;
        }
        structural = true;
        cy.add(def);
      });
      // Seed new nodes next to an already-placed neighbour so the incremental layout settles quickly.
      if (!first) {
        const ext = cy.extent();
        fresh.forEach((id) => {
          const n = cy.nodes().getElementById(id);
          if (n.empty() || n.position().x !== 0 || n.position().y !== 0) return;
          const placed = n.neighborhood().nodes().filter((m) => !fresh.has(m.id()));
          if (placed.nonempty()) {
            const p = (placed.first() as NodeSingular).position();
            n.position({ x: p.x + (Math.random() - 0.5) * 60, y: p.y + (Math.random() - 0.5) * 60 });
          } else {
            n.position({ x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 });
          }
        });
      }
    });
    applyFilters(cy);
    if (structural || fresh.size) runLayout(cy, first);

    // Pulse what is new since the previous graph version.
    cy.nodes(".fresh").removeClass("fresh");
    if (fresh.size) {
      const els = cy.collection();
      fresh.forEach((id) => {
        const n = cy.getElementById(id);
        if (n.nonempty()) els.merge(n);
      });
      els.addClass("fresh");
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
      for (let i = 0; i < 6; i++) {
        timers.current.push(window.setTimeout(() => els.toggleClass("flash", i % 2 === 0), 120 + i * 420));
      }
      timers.current.push(window.setTimeout(() => els.removeClass("flash"), 120 + 6 * 420));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Filters changed.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !cy.nodes().length) return;
    applyFilters(cy);
    runLayout(cy, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy && relayoutKey > 0) runLayout(cy, true);
  }, [relayoutKey]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy && fitKey > 0) cy.animate({ fit: { eles: cy.elements().not(".filtered"), padding: 36 }, duration: 300 });
  }, [fitKey]);

  // Selection & replay emphasis.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const view: { focus: cytoscape.CollectionReturnValue | null } = { focus: null };
    cy.batch(() => {
      cy.elements().removeClass("faded focus selected conflict-side replay dim-replay");
      const sel = selectedId ? cy.getElementById(selectedId) : null;
      if (sel && sel.nonempty() && !sel.hasClass("filtered")) {
        let focus = sel.closedNeighborhood().not(".filtered");
        if (sel.data("type") === "Contradiction") {
          // Both conflicting claims (INVOLVES) plus the placements they assert (BETWEEN).
          const sides = sel.outgoers("edge.e-INVOLVES").targets();
          sides.addClass("conflict-side");
          const between = sel.outgoers("edge.e-BETWEEN").targets();
          const direct = sides.edgesWith(sides).union(between.connectedEdges().filter((e) => sides.contains(e.source()) || sides.contains(e.target())));
          focus = focus.union(sides).union(between).union(direct).not(".filtered");
        }
        cy.elements().not(focus).addClass("faded");
        focus.addClass("focus");
        sel.addClass("selected");
        view.focus = focus;
      } else if (replayIds && replayIds.size) {
        const hits = cy.nodes().filter((n) => replayIds.has(n.id()));
        cy.elements().not(hits).not(hits.edgesWith(hits)).addClass("dim-replay");
        hits.addClass("replay");
        hits.edgesWith(hits).addClass("focus");
      }
    });
    // Keep the focused neighbourhood clear of the inspector overlay (right ~360px).
    if (view.focus) {
      const focus = view.focus;
      const bb = focus.boundingBox({});
      const w = cy.width();
      const h = cy.height();
      const availW = Math.max(200, w - 370);
      const pad = 40;
      const zoom = Math.min(cy.zoom(), availW / (bb.w + 2 * pad), h / (bb.h + 2 * pad));
      const pan = cy.pan();
      const z0 = cy.zoom();
      const r = { x1: bb.x1 * z0 + pan.x, x2: bb.x2 * z0 + pan.x, y1: bb.y1 * z0 + pan.y, y2: bb.y2 * z0 + pan.y };
      const inside = zoom === z0 && r.x1 >= 8 && r.x2 <= availW && r.y1 >= 8 && r.y2 <= h - 8;
      if (!inside) {
        const cx = (bb.x1 + bb.x2) / 2;
        const cyy = (bb.y1 + bb.y2) / 2;
        cy.animate({ zoom, pan: { x: availW / 2 - cx * zoom, y: h / 2 - cyy * zoom }, duration: 350, easing: "ease-out" });
      }
    }
  }, [selectedId, replayIds, graph, filters]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="Evidence graph" role="img" />;
}
