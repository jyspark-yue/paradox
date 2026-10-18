"""FalkorDB-backed knowledge store for one case investigation.

All agent-readable investigation state lives here. Every read used by the reasoning engines
is a fixed, parameterised Cypher template — there is no free-form query surface.
"""

from __future__ import annotations

import json
from typing import Any

from paradox.cases.schema import Assertion, Perturbation, Placement, PublicCase
from paradox.graph.db import GraphUnavailableError, get_db, graph_name

# Node labels that are part of the investigation's bookkeeping rather than the case itself.
INTERNAL_LABELS = {"OutcomeClass", "BeliefState", "Decision", "Case"}


def fmt_time(minutes: int | None) -> str:
    if minutes is None:
        return "?"
    h, m = divmod(int(minutes) % 1440, 60)
    suffix = "AM" if h < 12 else "PM"
    return f"{(h % 12) or 12}:{m:02d} {suffix}"


def _to_py(value: Any) -> Any:
    """Convert FalkorDB result values (nodes, edges, paths) into plain JSON-able data."""
    if hasattr(value, "labels") and hasattr(value, "properties"):
        return {"labels": list(value.labels), **dict(value.properties)}
    if hasattr(value, "relation") and hasattr(value, "properties"):
        return {"type": value.relation, **dict(value.properties)}
    if isinstance(value, list):
        return [_to_py(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_py(v) for k, v in value.items()}
    return value


class GraphStore:
    def __init__(self, case_id: str, name: str | None = None):
        self.case_id = case_id
        self.name = name or graph_name(case_id)
        self._graph = None

    # ------------------------------------------------------------------ infrastructure
    @property
    def graph(self):
        if self._graph is None:
            self._graph = get_db().select_graph(self.name)
        return self._graph

    def query(self, cypher: str, params: dict | None = None) -> list[dict]:
        try:
            result = self.graph.query(cypher, params or {})
        except GraphUnavailableError:
            raise
        except ConnectionError as exc:
            raise GraphUnavailableError(str(exc)) from exc
        header = [h[1] if isinstance(h, (list, tuple)) else h for h in (result.header or [])]
        return [dict(zip(header, (_to_py(v) for v in row))) for row in result.result_set]

    def exists(self) -> bool:
        try:
            return self.name in get_db().list_graphs()
        except Exception as exc:
            raise GraphUnavailableError(str(exc)) from exc

    def delete(self) -> None:
        if self.exists():
            self.graph.delete()
        self._graph = None

    # ------------------------------------------------------------------ seeding
    def seed(self, case: PublicCase, session_id: str) -> None:
        self.delete()
        cfg = case.config
        self.query(
            """
            CREATE (:Case {id: $id, title: $title, summary: $summary, session_id: $session,
                budget: $budget, spent: 0, actions_taken: 0, max_actions: $max_actions,
                confidence_threshold: $thr, min_supporting_bundles: $min_bundles,
                negligible_eig: $neg, relevance_minutes: $rel, crime_scene: $scene,
                window_start: $ws, window_end: $we, incident_time: $it,
                version: 0, status: 'open', status_reason: '', perturbations: '[]'})
            """,
            {
                "id": case.id, "title": case.title, "summary": case.summary.strip(), "session": session_id,
                "budget": cfg.budget, "max_actions": cfg.max_actions, "thr": cfg.confidence_threshold,
                "min_bundles": cfg.min_supporting_bundles, "neg": cfg.negligible_eig,
                "rel": cfg.relevance_minutes, "scene": case.crime_scene, "ws": case.window_start,
                "we": case.window_end, "it": case.incident_time,
            },
        )
        self.query(
            "UNWIND $rows AS r CREATE (:Location {id: r.id, name: r.name, type: r.type})",
            {"rows": [loc.model_dump() for loc in case.locations]},
        )
        self.query("MATCH (c:Case), (l:Location {id: $scene}) CREATE (c)-[:CRIME_SCENE]->(l)", {"scene": case.crime_scene})
        self.query(
            """
            UNWIND $rows AS r
            MATCH (a:Location {id: r.a}), (b:Location {id: r.b})
            CREATE (a)-[:CONNECTED_TO {minutes: r.minutes}]->(b)
            """,
            {"rows": [c.model_dump() for c in case.connections]},
        )
        self.query(
            "UNWIND $rows AS r CREATE (:Person {id: r.id, name: r.name, role: r.role, suspect: r.suspect, bio: r.bio})",
            {"rows": [p.model_dump(exclude={"access"}) for p in case.people]},
        )
        self.query(
            """
            UNWIND $rows AS r
            MATCH (p:Person {id: r.person}), (l:Location {id: r.loc})
            CREATE (p)-[:HAS_ACCESS_TO]->(l)
            """,
            {"rows": [{"person": p.id, "loc": loc} for p in case.people for loc in p.access]},
        )
        self.query(
            """
            UNWIND $rows AS r
            MATCH (p:Person {id: r.implicates})
            CREATE (h:Hypothesis {id: r.id, description: r.description,
                    prior_probability: r.prior, posterior_probability: r.prior})-[:IMPLICATES]->(p)
            """,
            {"rows": [h.model_dump() for h in case.hypotheses]},
        )
        for st in case.statements:
            self.create_statement(st.id, st.speaker, st.content, st.recorded_at, st.claim_type,
                                  st.placements, st.assertions, source="initial")
        self.query(
            """
            UNWIND $rows AS r
            CREATE (:Evidence {id: r.id, evidence_type: r.evidence_type, name: r.evidence_type,
                description: r.description, discovered: true, accessible: true,
                reliability: r.reliability, provenance: r.provenance, bundle: 'initial', initial: true})
            """,
            {"rows": [e.model_dump() for e in case.initial_evidence]},
        )
        self.query(
            """
            UNWIND $rows AS r
            CREATE (:Evidence {id: r.id, evidence_type: r.evidence_type, name: r.name,
                description: '', discovered: false, accessible: true, initial: false})
            """,
            {"rows": [s.model_dump() for s in case.evidence_sources]},
        )
        self.query(
            """
            UNWIND $rows AS r
            MATCH (e:Evidence {id: r.id}), (l:Location {id: r.location})
            CREATE (e)-[:LOCATED_AT]->(l)
            """,
            {"rows": [s.model_dump() for s in case.evidence_sources if s.location]},
        )
        for a in case.actions:
            self.query(
                """
                CREATE (a:InvestigationAction {id: $id, type: $type, label: $label, description: $desc,
                    cost: $cost, bundle: $bundle, activity: $activity, available: true,
                    executed: false, target_id: $target})
                """,
                {"id": a.id, "type": a.type, "label": a.label, "desc": a.description, "cost": a.cost,
                 "bundle": a.bundle, "activity": a.activity, "target": a.target or ""},
            )
            if a.examines:
                self.query(
                    "MATCH (a:InvestigationAction {id: $a}), (e:Evidence {id: $e}) CREATE (a)-[:EXAMINES]->(e)",
                    {"a": a.id, "e": a.examines},
                )
            if a.target:
                self.query(
                    "MATCH (a:InvestigationAction {id: $a}), (p:Person {id: $p}) CREATE (a)-[:TARGETS]->(p)",
                    {"a": a.id, "p": a.target},
                )
            if a.requires_contradiction_on:
                self.query(
                    "MATCH (a:InvestigationAction {id: $a}), (p:Person {id: $p}) CREATE (a)-[:REQUIRES_CONTRADICTION_ON]->(p)",
                    {"a": a.id, "p": a.requires_contradiction_on},
                )
            rows = []
            tables = [("", a.likelihoods)] + [
                ("&".join(f"{k}={v}" for k, v in sorted(c.given.items())), c.likelihoods) for c in a.conditional
            ]
            for given, table in tables:
                for hid, dist in table.items():
                    for code, p in dist.items():
                        rows.append({"oc": f"{a.id}:{code}", "h": hid, "p": p, "given": given})
            self.query(
                """
                MATCH (a:InvestigationAction {id: $a})
                UNWIND $outcomes AS o
                CREATE (a)-[:HAS_OUTCOME]->(:OutcomeClass {id: $a + ':' + o.code, code: o.code, label: o.label, action_id: $a})
                """,
                {"a": a.id, "outcomes": [o.model_dump() for o in a.outcomes]},
            )
            self.query(
                """
                UNWIND $rows AS r
                MATCH (o:OutcomeClass {id: r.oc}), (h:Hypothesis {id: r.h})
                CREATE (o)-[:LIKELIHOOD {p: r.p, given: r.given}]->(h)
                """,
                {"rows": rows},
            )
        for a in case.actions:
            for req in a.requires:
                self.query(
                    "MATCH (a:InvestigationAction {id: $a}), (b:InvestigationAction {id: $b}) CREATE (a)-[:REQUIRES]->(b)",
                    {"a": a.id, "b": req},
                )

    def create_statement(self, sid: str, speaker: str, content: str, recorded_at: int, claim_type: str,
                         placements: list[Placement], assertions: list[Assertion], source: str,
                         source_evidence_id: str = "") -> None:
        self.query(
            """
            MATCH (p:Person {id: $speaker})
            CREATE (p)-[:MADE]->(:Statement {id: $id, speaker_id: $speaker, content: $content,
                recorded_at: $at, claim_type: $ct, source: $source, source_evidence_id: $sev, revision: 0})
            """,
            {"speaker": speaker, "id": sid, "content": content, "at": recorded_at, "ct": claim_type,
             "source": source, "sev": source_evidence_id},
        )
        self._attach_events("Statement", sid, "ABOUT", "alleged", placements, assertions)

    def _attach_events(self, owner_label: str, owner_id: str, rel: str, status: str,
                       placements: list[Placement], assertions: list[Assertion]) -> None:
        placements = [Placement.model_validate(p) if isinstance(p, dict) else p for p in placements]
        assertions = [Assertion.model_validate(a) if isinstance(a, dict) else a for a in assertions]
        for i, pl in enumerate(placements):
            self.query(
                f"""
                MATCH (o:{owner_label} {{id: $owner}}), (l:Location {{id: $loc}}), (p:Person {{id: $subj}})
                CREATE (o)-[:{rel}]->(ev:Event {{id: $id, event_type: 'placement', status: $status,
                    subject_id: $subj, location_id: $loc, time_start: $s, time_end: $e,
                    description: p.name + ' at ' + l.name + ' ' + $span}})
                CREATE (ev)-[:OCCURRED_AT]->(l)
                CREATE (ev)-[:PLACES]->(p)
                """,
                {"owner": owner_id, "loc": pl.location, "subj": pl.subject, "id": f"{owner_id}:p{i}",
                 "status": status, "s": pl.start, "e": pl.end, "span": f"{fmt_time(pl.start)}–{fmt_time(pl.end)}"},
            )
        for i, asr in enumerate(assertions):
            self.query(
                f"""
                MATCH (o:{owner_label} {{id: $owner}}), (p:Person {{id: $subj}})
                CREATE (o)-[:{rel}]->(ev:Event {{id: $id, event_type: 'assertion', status: $status,
                    subject_id: $subj, predicate: $pred, value: $val, time_start: $s, time_end: $e,
                    description: p.name + ' ' + $pred_text + ' ' + $span}})
                CREATE (ev)-[:PLACES]->(p)
                """,
                {"owner": owner_id, "subj": asr.subject, "id": f"{owner_id}:a{i}", "status": status,
                 "pred": asr.predicate, "val": asr.value, "s": asr.start, "e": asr.end,
                 "pred_text": ("" if asr.value else "NOT ") + asr.predicate.replace("_", " "),
                 "span": f"{fmt_time(asr.start)}–{fmt_time(asr.end)}"},
            )

    # ------------------------------------------------------------------ case meta
    def case(self) -> dict:
        rows = self.query("MATCH (c:Case) RETURN c")
        if not rows:
            raise KeyError(f"case graph '{self.name}' is not initialised")
        c = rows[0]["c"]
        c.pop("labels", None)
        return c

    def update_case(self, **props) -> None:
        self.query("MATCH (c:Case) SET c += $props", {"props": props})

    def bump_version(self) -> int:
        return self.query("MATCH (c:Case) SET c.version = c.version + 1 RETURN c.version AS v")[0]["v"]

    # ------------------------------------------------------------------ reads: model
    def hypotheses(self) -> list[dict]:
        return self.query(
            """
            MATCH (h:Hypothesis)-[:IMPLICATES]->(p:Person)
            RETURN h.id AS id, h.description AS description, h.prior_probability AS prior,
                   h.posterior_probability AS posterior, p.id AS person_id, p.name AS person_name
            ORDER BY h.id
            """
        )

    def actions(self) -> list[dict]:
        return self.query(
            """
            MATCH (a:InvestigationAction)
            OPTIONAL MATCH (a)-[:EXAMINES]->(e:Evidence)
            OPTIONAL MATCH (e)-[:LOCATED_AT]->(l:Location)
            OPTIONAL MATCH (a)-[:TARGETS]->(t:Person)
            OPTIONAL MATCH (a)-[:REQUIRES_CONTRADICTION_ON]->(rp:Person)
            RETURN a.id AS id, a.type AS type, a.label AS label, a.description AS description,
                   a.cost AS cost, a.bundle AS bundle, a.activity AS activity, a.executed AS executed,
                   a.available AS available, e.id AS evidence_id, e.name AS evidence_name,
                   e.accessible AS evidence_accessible, l.id AS location_id, l.name AS location_name,
                   t.id AS target_id, t.name AS target_name, rp.id AS requires_contradiction_on
            ORDER BY a.id
            """
        )

    def action_requirements(self) -> dict[str, list[dict]]:
        rows = self.query(
            """
            MATCH (a:InvestigationAction)-[:REQUIRES]->(b:InvestigationAction)
            RETURN a.id AS action, b.id AS required, b.label AS label, b.executed AS executed
            """
        )
        out: dict[str, list[dict]] = {}
        for r in rows:
            out.setdefault(r["action"], []).append(r)
        return out

    def outcome_classes(self) -> dict[str, list[dict]]:
        rows = self.query(
            """
            MATCH (a:InvestigationAction)-[:HAS_OUTCOME]->(o:OutcomeClass)
            RETURN a.id AS action, o.code AS code, o.label AS label ORDER BY a.id, o.id
            """
        )
        out: dict[str, list[dict]] = {}
        for r in rows:
            out.setdefault(r["action"], []).append({"code": r["code"], "label": r["label"]})
        return out

    def likelihood_rows(self) -> list[dict]:
        return self.query(
            """
            MATCH (a:InvestigationAction)-[:HAS_OUTCOME]->(o:OutcomeClass)-[l:LIKELIHOOD]->(h:Hypothesis)
            RETURN a.id AS action, o.code AS code, h.id AS hypothesis, l.p AS p, l.given AS given
            """
        )

    def observations(self) -> list[dict]:
        return self.query(
            """
            MATCH (o:Observation)-[:RESULT_OF]->(a:InvestigationAction)
            OPTIONAL MATCH (o)-[:REVEALS]->(e:Evidence)
            RETURN o.id AS id, o.seq AS seq, a.id AS action_id, a.label AS action_label, a.cost AS cost,
                   a.bundle AS bundle, o.outcome_code AS outcome_code, o.outcome_label AS outcome_label,
                   o.discovered_at AS discovered_at, e.id AS evidence_id, e.description AS evidence_description,
                   e.reliability AS reliability
            ORDER BY o.seq
            """
        )

    def travel_minutes(self) -> dict[tuple[str, str], int]:
        """All-pairs shortest walking time, computed by graph traversal over CONNECTED_TO."""
        rows = self.query(
            """
            MATCH p = (a:Location)-[:CONNECTED_TO*1..8]-(b:Location)
            WHERE a.id < b.id
            RETURN a.id AS a, b.id AS b, min(reduce(t = 0, r IN relationships(p) | t + r.minutes)) AS minutes
            """
        )
        out: dict[tuple[str, str], int] = {}
        for r in rows:
            out[(r["a"], r["b"])] = r["minutes"]
            out[(r["b"], r["a"])] = r["minutes"]
        return out

    def distance_from_crime_scene(self) -> dict[str, int]:
        rows = self.query(
            """
            MATCH (:Case)-[:CRIME_SCENE]->(s:Location)
            MATCH p = (s)-[:CONNECTED_TO*1..8]-(l:Location)
            WHERE l <> s
            RETURN l.id AS id, min(reduce(t = 0, r IN relationships(p) | t + r.minutes)) AS minutes
            """
        )
        scene = self.query("MATCH (:Case)-[:CRIME_SCENE]->(s:Location) RETURN s.id AS id")[0]["id"]
        out = {r["id"]: r["minutes"] for r in rows}
        out[scene] = 0
        return out

    def contradicted_people(self) -> set[str]:
        rows = self.query(
            """
            MATCH (p:Person)-[:MADE]->(s:Statement)<-[:INVOLVES]-(k:Contradiction)
            WHERE k.status <> 'refuted' AND k.subject_id = p.id
            RETURN DISTINCT p.id AS id
            """
        )
        return {r["id"] for r in rows}

    # ------------------------------------------------------------------ reads: claims & contradictions
    def claim_events(self) -> list[dict]:
        return self.query(
            """
            MATCH (ev:Event)-[:PLACES]->(p:Person)
            OPTIONAL MATCH (s:Statement)-[:ABOUT]->(ev)
            OPTIONAL MATCH (sp:Person)-[:MADE]->(s)
            OPTIONAL MATCH (e:Evidence)-[:RECORDS]->(ev)
            OPTIONAL MATCH (l:Location {id: ev.location_id})
            OPTIONAL MATCH (x:Evidence)-[:EXPLAINS]->(ev)
            RETURN ev.id AS id, ev.event_type AS kind, ev.status AS status, ev.subject_id AS subject,
                   p.name AS subject_name, ev.location_id AS location, l.name AS location_name,
                   ev.predicate AS predicate, ev.value AS value, ev.time_start AS start, ev.time_end AS end,
                   s.id AS statement_id, s.content AS statement_content, s.source_evidence_id AS statement_evidence,
                   sp.id AS speaker_id, sp.name AS speaker_name,
                   e.id AS evidence_id, e.name AS evidence_name, e.reliability AS reliability, e.bundle AS bundle,
                   collect(x.id) AS explained_by
            ORDER BY ev.id
            """
        )

    def replace_contradictions(self, contradictions: list[dict], corroborations: list[dict]) -> None:
        self.query("MATCH (k:Contradiction) DETACH DELETE k")
        self.query("MATCH ()-[r:CONTRADICTS|CORROBORATES|CONFLICTS_WITH]->() DELETE r")
        for k in contradictions:
            self.query(
                """
                CREATE (k:Contradiction {id: $id, contradiction_type: $type, rule: $rule, description: $desc,
                    status: $status, status_reason: $reason, subject_id: $subject, travel_minutes: $travel,
                    gap_minutes: $gap, event_ids: $events, explained_evidence: $explained,
                    losing_evidence: $losing})
                WITH k
                UNWIND $events AS eid
                MATCH (ev:Event {id: eid})
                CREATE (k)-[:BETWEEN]->(ev)
                """,
                {"id": k["id"], "type": k["type"], "rule": k["rule"], "desc": k["description"],
                 "status": k["status"], "reason": k["status_reason"], "subject": k["subject"],
                 "travel": k.get("travel_minutes", -1), "gap": k.get("gap_minutes", -1),
                 "events": k["event_ids"], "explained": k["explained_evidence"],
                 "losing": k["losing_evidence"]},
            )
            for sid in k["statement_ids"]:
                self.query(
                    "MATCH (k:Contradiction {id: $k}), (s:Statement {id: $s}) CREATE (k)-[:INVOLVES]->(s)",
                    {"k": k["id"], "s": sid},
                )
            for eid in k["evidence_ids"]:
                self.query(
                    "MATCH (k:Contradiction {id: $k}), (e:Evidence {id: $e}) CREATE (k)-[:INVOLVES]->(e)",
                    {"k": k["id"], "e": eid},
                )
            if k["rule"] == "B":
                self.query(
                    """
                    MATCH (e:Evidence {id: $e}), (s:Statement {id: $s})
                    CREATE (e)-[:CONTRADICTS {contradiction_id: $k, confidence: $c}]->(s)
                    """,
                    {"e": k["evidence_ids"][0], "s": k["statement_ids"][0], "k": k["id"], "c": k.get("confidence", 0.0)},
                )
            elif k["rule"] in ("A", "C"):
                self.query(
                    """
                    MATCH (a:Statement {id: $a}), (b:Statement {id: $b})
                    CREATE (a)-[:CONFLICTS_WITH {contradiction_id: $k}]->(b)
                    """,
                    {"a": k["statement_ids"][0], "b": k["statement_ids"][1], "k": k["id"]},
                )
            elif k["rule"] == "D":
                self.query(
                    """
                    MATCH (a:Evidence {id: $a}), (b:Evidence {id: $b})
                    CREATE (a)-[:CONFLICTS_WITH {contradiction_id: $k}]->(b)
                    """,
                    {"a": k["evidence_ids"][0], "b": k["evidence_ids"][1], "k": k["id"]},
                )
        if corroborations:
            self.query(
                """
                UNWIND $rows AS r
                MATCH (e:Evidence {id: r.evidence}), (s:Statement {id: r.statement})
                MERGE (e)-[c:CORROBORATES]->(s)
                SET c.confidence = r.confidence, c.event = r.event
                """,
                {"rows": corroborations},
            )

    def contradictions(self) -> list[dict]:
        return self.query(
            """
            MATCH (k:Contradiction)
            OPTIONAL MATCH (k)-[:INVOLVES]->(s:Statement)
            OPTIONAL MATCH (k)-[:INVOLVES]->(e:Evidence)
            RETURN k.id AS id, k.contradiction_type AS type, k.rule AS rule, k.description AS description,
                   k.status AS status, k.status_reason AS status_reason, k.subject_id AS subject_id,
                   k.event_ids AS event_ids, k.explained_evidence AS explained_evidence,
                   k.losing_evidence AS losing_evidence, collect(DISTINCT s.id) AS statement_ids,
                   collect(DISTINCT e.id) AS evidence_ids
            ORDER BY k.id
            """
        )

    # ------------------------------------------------------------------ writes: investigation
    def record_observation(self, *, seq: int, action_id: str, outcome_code: str, outcome_label: str,
                           evidence_id: str, description: str, reliability: float, provenance: str,
                           bundle: str, records: list[Placement], assertions: list[Assertion],
                           statements: list[dict], explains: list[dict], discovered_at: int) -> str:
        obs_id = f"obs_{seq:02d}"
        self.query(
            """
            MATCH (a:InvestigationAction {id: $a}), (e:Evidence {id: $e}), (oc:OutcomeClass {id: $oc})
            SET a.executed = true, a.available = false,
                e.discovered = true, e.description = $desc, e.reliability = $rel,
                e.provenance = $prov, e.bundle = $bundle
            CREATE (o:Observation {id: $obs, seq: $seq, action_id: $a, outcome_code: $code,
                    outcome_label: $label, discovered_at: $at})
            CREATE (o)-[:RESULT_OF]->(a)
            CREATE (o)-[:REVEALS]->(e)
            CREATE (o)-[:OBSERVED_OUTCOME]->(oc)
            """,
            {"a": action_id, "e": evidence_id, "oc": f"{action_id}:{outcome_code}", "desc": description,
             "rel": reliability, "prov": provenance, "bundle": bundle, "obs": obs_id, "seq": seq,
             "code": outcome_code, "label": outcome_label, "at": discovered_at},
        )
        self._attach_events("Evidence", evidence_id, "RECORDS", "recorded", records, assertions)
        for st in statements:
            self.create_statement(st["id"], st["speaker"], st["content"], discovered_at, st["claim_type"],
                                  st["placements"], st["assertions"], source="revealed",
                                  source_evidence_id=evidence_id)
            self.query(
                "MATCH (e:Evidence {id: $e}), (s:Statement {id: $s}) CREATE (e)-[:CAPTURES]->(s)",
                {"e": evidence_id, "s": st["id"]},
            )
        for ex in explains:
            self.query(
                """
                MATCH (src:Evidence)-[:RECORDS]->(ev:Event {subject_id: $subj})
                MATCH (:InvestigationAction {id: $act})-[:EXAMINES]->(src)
                MATCH (e:Evidence {id: $e})
                CREATE (e)-[:EXPLAINS {reason: $reason}]->(ev)
                """,
                {"subj": ex["subject"], "act": ex["action"], "e": evidence_id, "reason": ex["reason"]},
            )
        return obs_id

    def write_hypothesis_links(self, evidence_id: str, links: list[dict]) -> None:
        self.query(
            """
            UNWIND $rows AS r
            MATCH (e:Evidence {id: $e}), (h:Hypothesis {id: r.h})
            FOREACH (_ IN CASE WHEN r.kind = 'SUPPORTS' THEN [1] ELSE [] END |
                CREATE (e)-[:SUPPORTS {weight: r.ratio, provenance: 'likelihood ratio'}]->(h))
            FOREACH (_ IN CASE WHEN r.kind = 'CHALLENGES' THEN [1] ELSE [] END |
                CREATE (e)-[:CHALLENGES {weight: r.ratio, provenance: 'likelihood ratio'}]->(h))
            """,
            {"e": evidence_id, "rows": links},
        )

    def evidence_links(self) -> list[dict]:
        return self.query(
            """
            MATCH (e:Evidence)-[r:SUPPORTS|CHALLENGES]->(h:Hypothesis)
            RETURN e.id AS evidence_id, e.bundle AS bundle, type(r) AS kind, r.weight AS weight, h.id AS hypothesis
            """
        )

    def set_posteriors(self, posteriors: dict[str, float]) -> None:
        self.query(
            "UNWIND $rows AS r MATCH (h:Hypothesis {id: r.id}) SET h.posterior_probability = r.p",
            {"rows": [{"id": k, "p": v} for k, v in posteriors.items()]},
        )

    def append_belief(self, seq: int, posteriors: dict[str, float], entropy: float, cause: str) -> None:
        self.query(
            "CREATE (:BeliefState {seq: $seq, probs: $probs, entropy: $h, cause_observation_id: $cause})",
            {"seq": seq, "probs": json.dumps(posteriors), "h": entropy, "cause": cause},
        )

    def belief_history(self) -> list[dict]:
        rows = self.query(
            "MATCH (b:BeliefState) RETURN b.seq AS seq, b.probs AS probs, b.entropy AS entropy, "
            "b.cause_observation_id AS cause ORDER BY b.seq"
        )
        for r in rows:
            r["probs"] = json.loads(r["probs"])
        return rows

    def append_decision(self, decision: dict) -> None:
        self.query(
            """
            CREATE (d:Decision {seq: $seq, action_id: $action, policy: $policy, payload: $payload})
            WITH d
            OPTIONAL MATCH (a:InvestigationAction {id: $action})
            FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (d)-[:CHOSE]->(a))
            """,
            {"seq": decision["seq"], "action": decision.get("action_id") or "", "policy": decision["policy"],
             "payload": json.dumps(decision)},
        )

    def decisions(self) -> list[dict]:
        rows = self.query("MATCH (d:Decision) RETURN d.payload AS payload ORDER BY d.seq")
        return [json.loads(r["payload"]) for r in rows]

    # ------------------------------------------------------------------ perturbations
    def apply_perturbation(self, perturbation: Perturbation) -> None:
        for op in perturbation.ops:
            if op.op == "remove_connection":
                self.query(
                    "MATCH (a:Location {id: $a})-[r:CONNECTED_TO]-(b:Location {id: $b}) DELETE r",
                    {"a": op.a, "b": op.b},
                )
            elif op.op == "add_connection":
                self.query(
                    "MATCH (a:Location {id: $a}), (b:Location {id: $b}) CREATE (a)-[:CONNECTED_TO {minutes: $m}]->(b)",
                    {"a": op.a, "b": op.b, "m": op.minutes},
                )
            elif op.op == "revise_statement":
                self.query(
                    "MATCH (s:Statement {id: $s})-[:ABOUT]->(ev:Event) DETACH DELETE ev", {"s": op.statement}
                )
                self.query(
                    "MATCH (s:Statement {id: $s}) SET s.content = $c, s.revision = s.revision + 1",
                    {"s": op.statement, "c": op.content},
                )
                self._attach_events("Statement", op.statement, "ABOUT", "alleged",
                                    op.placements or [], op.assertions or [])
        applied = json.loads(self.case()["perturbations"])
        applied.append(perturbation.id)
        self.update_case(perturbations=json.dumps(applied))

    # ------------------------------------------------------------------ visualisation
    def visible_graph(self) -> dict:
        nodes = self.query(
            """
            MATCH (n)
            WHERE NOT n:OutcomeClass AND NOT n:BeliefState AND NOT n:Decision AND NOT n:Case
            RETURN n
            """
        )
        edges = self.query(
            """
            MATCH (a)-[r]->(b)
            WHERE NOT a:OutcomeClass AND NOT b:OutcomeClass AND NOT a:Decision AND NOT a:Case
                  AND NOT b:Case AND NOT a:BeliefState
            RETURN a.id AS source, b.id AS target, type(r) AS type, properties(r) AS props
            """
        )
        out_nodes = []
        for row in nodes:
            n = row["n"]
            labels = n.pop("labels")
            out_nodes.append({"id": n["id"], "type": labels[0], "properties": n})
        return {"nodes": out_nodes, "edges": edges}
