# Recant - agent memory that can take it back

**Graph Hacks: Context for AI Agents** · built on **FalkorDB**
Tracks entered: **Agent Memory and Coordination** (primary) · **Agents That Act on Connected Data**

**[Live demo](https://recant.onrender.com)** · **[Demo video](https://youtu.be/0MGY-S4MVZI)** · **[Write-up](https://dev.to/imarpan/i-built-an-ai-agent-memory-that-can-undo-false-beliefs-2j21)**

The live demo starts in its September state, so you can walk the whole thing
yourself: ask the question, deliver October, retract the belief, ask again.

---

## The problem

Agent memory is built to accumulate. Every framework will happily store a fact,
embed it, and hand it back later. None of them can answer the question that
actually matters in production:

> A document we ingested three weeks ago turned out to be wrong.
> **What does the agent now believe because of it?**

In a vector store, nothing. The bad fact was embedded, reasoned over, and the
conclusions were written back as new memories with no link to where they came
from. Deleting the source changes nothing. The agent keeps confidently asserting
conclusions whose foundation has been removed, and keeps citing them.

That is memory rot, and it is a graph problem.

## What Recant does

Recant is a memory layer where **provenance is the data model**. Every remembered
claim knows which document asserted it and which other claims it was inferred
from. So retraction becomes a traversal:

1. Mark a source as retracted.
2. Every claim that *only* that source asserted loses its footing.
3. Every inference standing on those claims collapses, transitively, hop by hop.
4. Every past answer that relied on any collapsed claim is marked **stale**.
5. Ask the same question again and the answer is different - and it can show you
   exactly which chain of reasoning disappeared.

Claims corroborated by a surviving source **do not** collapse. That distinction
is the whole point, and it is only expressible as a graph.

### The demo

The corpus is a fictional company, Northwind Commerce, and it is **a timeline**.
Seeding loads only the seven September documents - the state the team was in
before anything went wrong. There is one deliberate trap in them: a load test
whose numbers are invalid, and four downstream documents that quietly build on
it. October's incident and postmortem arrive later, as they would in real life.

Run `npm run demo` to watch the whole thing in the terminal, or click through it
in the UI.

| | |
|---|---|
| **1. Ask** | *"Are we ready for Black Friday on the current Checkout API setup?"* → **YES**, with a provenance chain back to the September load test's 1,200 rps ceiling. The agent is not being stupid: that genuinely is what September's documents say. |
| **2. Diagnose** | PageRank over `DERIVED_FROM` ranks the load-bearing beliefs - the ones the most reasoning rests on, and so the ones you would least like to be wrong. |
| **3. October arrives** | Deliver the incident and the postmortem. On ingest the graph detects the conflict: the postmortem's *"the 1,200 rps figure does not transfer to production"* contradicts the belief the whole plan stands on. |
| **4. Retract** | Withdraw that belief. Note what the blast radius says first: **two** documents assert it - the load test *and* the capacity plan that copied it. Retracting either document alone would leave the belief standing, which is exactly why claim-level retraction exists. Withdrawing it collapses 7 claims across 4 hops: the capacity figure, then "can absorb the peak", then "no additional capacity required", then the spend decision, then the $18k saving and the single-engineer on-call rota. The earlier answer is marked **stale**. |
| **5. Ask again** | Same question → **NO**, now citing the postmortem's corrected 520 rps ceiling. Meanwhile *"Checkout API runs on 3 nodes"* survives untouched - the independent platform audit also asserted it, so it never lost its footing. |

The headline number: **YES → NO**, with 7 beliefs collapsed and 1 past answer
invalidated, from a single operator action.

## Why FalkorDB is doing real work

Remove the graph and there is no product. Each core operation is a traversal
with no key-value or vector equivalent:

| Operation | Why it needs a graph |
|---|---|
| **Retraction cascade** | Transitive forward reachability over `DERIVED_FROM`, run to a fixpoint. The answer depends on edges, not on any claim's content. |
| **Corroboration survival** | Compare the count of *all* `STATES` edges into a claim against the count of retracted ones. A claim dies only when every source that asserted it is gone. |
| **"Why this answer"** | Variable-length path query from each claim the agent used, back to the documents that originally asserted it. |
| **Blast radius (read-only)** | One `*1..8` traversal of the downstream inference cone, before any mutation - a what-if on graph structure. |
| **Retrieval** | Seeds on entity nodes, then walks `DERIVED_FROM` up to 3 hops to pull in the reasoning each claim rests on, excluding collapsed claims at every hop. Similarity search cannot express "and everything this rests on." |
| **Load-bearing beliefs** | `algo.pageRank` over `DERIVED_FROM`. Edges point from conclusion to foundation, so incoming weight accumulates on the claims most reasoning depends on. |
| **Claim-level retraction** | Withdrawing a belief that several documents assert, and having the cascade compose correctly with source-level retractions, is a property of the edges into that node. |

### Two things the model is not trusted with

The extractor proposes graph structure, and a wrong edge is worse than a
missing one, so two deterministic guards sit between it and the graph:

- **Restatement is not inference.** Before any `DERIVED_FROM` edge is written,
  the child and parent texts are compared. If they are substantially the same
  assertion, the edge is rejected. Without this, a second document repeating
  "Checkout API runs on 3 nodes" gets linked as *derived from* the first - and
  a retraction would then cascade through a fact an independent audit still
  vouches for, destroying the corroboration guarantee.
- **Restatement is not conflict either.** The same check runs on proposed
  `CONTRADICTS` edges. The extractor did in fact once flag a pair and annotate
  it *"these claims are redundant but compatible, not conflicting"*; the guard
  drops it regardless of what the model says.

Likewise, the ids a model claims it relied on are intersected with the ids it
was actually given, and anything invented is discarded, because those edges decide
whether an answer later goes stale, so a false citation is not acceptable.

The LLM never searches. FalkorDB selects the subgraph; Gemini only does
structured extraction on the way in and synthesis on the way out - and it is
never shown a claim the graph has marked collapsed. **The graph, not the prompt,
is what forgets.**

---

## Graph data model

```
(:Source  {id, title, kind, text, trust, at, retracted, retractedAt, retractedReason})
(:Claim   {id, text, kind, confidence, at, tainted, taintDepth, taintReason,
           retracted, retractedAt, retractedReason})
(:Entity  {key, name, type})
(:Session {id, startedAt})
(:Question{id, text, askedAt})
(:Answer  {id, text, at, stale, staleReason})

(:Source)-[:STATES]->(:Claim)             a document asserts a claim
(:Claim)-[:DERIVED_FROM {rationale}]->(:Claim)   inference depends on claim
(:Claim)-[:SUPPORTS]->(:Claim)            corroboration, not load-bearing
(:Claim)-[:CONTRADICTS {note}]->(:Claim)  direct factual conflict
(:Claim)-[:ABOUT]->(:Entity)              what the claim is about
(:Answer)-[:BASED_ON]->(:Claim)           recorded provenance of an answer
(:Answer)-[:ANSWERS]->(:Question)
(:Question)-[:IN_SESSION]->(:Session)
```

Two design decisions carry most of the weight:

- **Claim ids are a content hash** (`c_` + sha1 of the normalised text). Two
  documents asserting the same fact converge on one `:Claim` node with two
  `STATES` edges. Corroboration is therefore structural, not a heuristic.
- **`DERIVED_FROM` points from conclusion to foundation.** Retraction walks it
  forward (`(d)-[:DERIVED_FROM*]->(tainted)`), PageRank accumulates weight
  backwards onto foundations. One edge direction serves both.

### Indexes

```cypher
CREATE INDEX FOR (s:Source) ON (s.id)
CREATE INDEX FOR (c:Claim) ON (c.id)
CREATE INDEX FOR (c:Claim) ON (c.tainted)
CREATE INDEX FOR (e:Entity) ON (e.key)
CREATE INDEX FOR (a:Answer) ON (a.id)
CREATE INDEX FOR (q:Question) ON (q.id)
CREATE FULLTEXT INDEX FOR (e:Entity) ON (e.name)
CREATE FULLTEXT INDEX FOR (c:Claim) ON (c.text)
```

---

## The queries the product depends on

All Cypher lives in [`src/queries.js`](src/queries.js) and is also served at
`GET /api/queries` so you can read exactly what ran. The load-bearing ones:

**1a. A belief withdrawn directly is a root of the cascade.** Source-level
retraction is not always enough: a wrong figure gets copied into later
documents, so the belief keeps standing on a source nobody has questioned.

```cypher
MATCH (c:Claim)
WHERE coalesce(c.retracted, false) = true
SET c.tainted = true,
    c.taintDepth = 0,
    c.taintReason = coalesce(c.retractedReason, 'this claim was retracted directly')
RETURN count(c) AS n
```

**1b. A claim loses its footing only when every source that stated it is retracted.**

```cypher
MATCH (src:Source)-[:STATES]->(c:Claim)
WITH c,
     count(src) AS total,
     sum(CASE WHEN coalesce(src.retracted, false) THEN 1 ELSE 0 END) AS retractedCount
WHERE total > 0 AND retractedCount = total
SET c.tainted = true,
    c.taintDepth = 0,
    c.taintReason = 'every source that stated this has been retracted'
RETURN count(c) AS n
```

**2. Propagation, iterated to a fixpoint.** Single-hop and repeated rather than
one variable-length write: it terminates on cyclic reasoning, and it gives every
claim an honest hop-distance from the retraction.

```cypher
MATCH (d:Claim)-[:DERIVED_FROM]->(p:Claim)
WHERE coalesce(p.tainted, false) = true AND coalesce(d.tainted, false) = false
SET d.tainted = true,
    d.taintDepth = coalesce(p.taintDepth, 0) + 1,
    d.taintReason = 'derived from a retracted claim: ' + p.text
RETURN count(d) AS n
```

**3. Answers inherit the damage.**

```cypher
MATCH (a:Answer)-[:BASED_ON]->(c:Claim)
WHERE coalesce(c.tainted, false) = true
WITH a, collect(c.text) AS broken
SET a.stale = true,
    a.staleReason = 'relies on ' + toString(size(broken)) + ' retracted claim(s)'
RETURN count(a) AS n
```

**4. Blast radius - read-only what-if, one traversal.**

```cypher
MATCH (s:Source {id: $sourceId})-[:STATES]->(root:Claim)
OPTIONAL MATCH (d:Claim)-[:DERIVED_FROM*1..8]->(root)
WITH s, collect(DISTINCT root) AS roots,
     [x IN collect(DISTINCT d) WHERE x IS NOT NULL] AS derived
OPTIONAL MATCH (a:Answer)-[:BASED_ON]->(ac:Claim)
WHERE ac IN roots OR ac IN derived
RETURN s.title AS title, size(roots) AS directClaims, size(derived) AS derivedClaims,
       [x IN collect(DISTINCT a.text) WHERE x IS NOT NULL] AS affectedAnswers,
       [x IN roots | x.text] AS rootTexts, [x IN derived | x.text] AS derivedTexts
```

**5. Retrieval - entity-seeded, multi-hop, collapse-aware.**

```cypher
UNWIND $seeds AS seed
MATCH (e:Entity {key: seed})<-[:ABOUT]-(c0:Claim)
WHERE coalesce(c0.tainted, false) = false AND coalesce(c0.retracted, false) = false
OPTIONAL MATCH (c0)-[:DERIVED_FROM*1..3]->(up:Claim)
WHERE coalesce(up.tainted, false) = false AND coalesce(up.retracted, false) = false
WITH collect(DISTINCT c0) AS seedClaims, collect(DISTINCT up) AS upstream
WITH seedClaims + upstream AS claims
UNWIND claims AS c
WITH DISTINCT c
WHERE c IS NOT NULL
OPTIONAL MATCH (src:Source)-[:STATES]->(c)
WHERE coalesce(src.retracted, false) = false
OPTIONAL MATCH (c)-[:ABOUT]->(ent:Entity)
OPTIONAL MATCH (c)-[:CONTRADICTS]-(conf:Claim)
WHERE coalesce(conf.tainted, false) = false
RETURN c.id AS id, c.text AS text, c.kind AS kind, c.confidence AS confidence, c.at AS at,
       collect(DISTINCT src.title) AS sources, collect(DISTINCT src.id) AS sourceIds,
       collect(DISTINCT ent.name) AS entities, collect(DISTINCT conf.text) AS contradictedBy
LIMIT 60
```

**6. "Why this answer" - provenance paths back to documents.**

```cypher
UNWIND $claimIds AS cid
MATCH (c:Claim {id: cid})
OPTIONAL MATCH p = (c)-[:DERIVED_FROM*0..4]->(base:Claim)
WITH c, base, p, length(p) AS hops
OPTIONAL MATCH (src:Source)-[:STATES]->(base)
RETURN c.id AS claimId, c.text AS claimText, hops,
       [n IN nodes(p) | n.id] AS chainIds, [n IN nodes(p) | n.text] AS chainTexts,
       base.id AS baseId, base.text AS baseText,
       src.id AS sourceId, src.title AS sourceTitle, src.kind AS sourceKind,
       coalesce(src.retracted, false) AS sourceRetracted
ORDER BY hops ASC
LIMIT 120
```

**7. Graph algorithm as an agent tool - load-bearing beliefs.**

```cypher
CALL algo.pageRank('Claim', 'DERIVED_FROM') YIELD node, score
WITH node, score
WHERE coalesce(node.tainted, false) = false
OPTIONAL MATCH (src:Source)-[:STATES]->(node)
OPTIONAL MATCH (dependent:Claim)-[:DERIVED_FROM*1..8]->(node)
RETURN node.id AS id, node.text AS text, score,
       count(DISTINCT dependent) AS dependents,
       [x IN collect(DISTINCT src.title) WHERE x IS NOT NULL] AS sources
ORDER BY score DESC, dependents DESC
LIMIT 8
```

---

## Running it

### Requirements

- Node.js 20 or newer
- A FalkorDB instance ([FalkorDB Cloud](https://app.falkordb.cloud) free tier, or Docker)
- A Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey)) - optional; without one the app runs in a graph-only fallback mode

### Setup

```bash
git clone https://github.com/imarpanpatra/recant.git
cd recant
npm install
cp .env.example .env     # then fill it in
npm run seed             # ingest September's 7 documents
npm start                # http://localhost:8080
```

| Script | What it does |
|---|---|
| `npm run seed` | Wipe and ingest the seven September documents |
| `npm run seed:october` | Deliver October's incident and postmortem into the existing memory |
| `npm run seed:all` | Ingest all nine documents at once |
| `npm run demo` | Reseed and run the whole five-beat story in the terminal |
| `npm run verify` | **39 assertions** against a real FalkorDB, covering the cascade, hop distances, corroboration survival, claim-level retraction, provenance paths, answer staleness and PageRank |
| `npm run reset` | Empty the graph |

`npm run verify` is the one to run first if you want to check the semantics
rather than the pitch. It builds its own fixture graph through the same queries
the app uses, with no LLM involved, and asserts the behaviour in both
directions - that a cascade fires, *and* that a corroborated claim does not
collapse when only one of its two sources is retracted.

`.env`:

```ini
# Endpoint and port come from the instance's Connect dialog. Percent-encode
# reserved characters in the password ($ -> %24, @ -> %40) or the URL parser
# will split it in the wrong place. Free-tier instances are plain TCP; use
# falkors:// only if yours has TLS enabled.
FALKORDB_URL=falkor://falkordb:<password>@<endpoint>.cloud:<port>
FALKORDB_GRAPH=recant
GEMINI_API_KEY=<your key>
PORT=8080
```

### Running FalkorDB locally instead

```bash
docker run -p 6379:6379 -p 3000:3000 -it falkordb/falkordb:latest
```

Then set `FALKORDB_HOST=localhost` and `FALKORDB_PORT=6379` instead of
`FALKORDB_URL`. The FalkorDB Browser on `:3000` is useful for watching the
`tainted` flags spread while you retract things.

### Using it

The UI seeds, asks, and retracts. Press **Seed memory** (or run `npm run seed`),
then use the suggested questions. Click any source to see its blast radius
before retracting it.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | FalkorDB reachability and which Gemini model is live |
| `GET` | `/api/stats` | claim / source / answer counts, including collapsed and stale |
| `POST` | `/api/seed` | ingest the corpus by phase - `{phase:1}` September (wipes), `{phase:2}` deliver October, `{phase:0}` everything (async; poll `/api/seed/status`) |
| `POST` | `/api/ingest` | ingest one `{title, text, kind}` document of your own |
| `POST` | `/api/ask` | `{question}` → answer, verdict, provenance chains, retrieval trace |
| `GET` | `/api/answers` | recorded answers, with staleness |
| `GET` | `/api/sources` | sources and their retraction state |
| `GET` | `/api/blast/:sourceId` | read-only blast radius for a source |
| `GET` | `/api/blast-claim/:claimId` | read-only blast radius for one belief, with the list of sources asserting it |
| `POST` | `/api/retract` | `{sourceId \| claimId, retracted, reason}` → cascade report |
| `POST` | `/api/recompute` | re-run the taint fixpoint |
| `GET` | `/api/load-bearing` | PageRank over `DERIVED_FROM` |
| `GET` | `/api/contradictions` | conflicts the graph is holding |
| `GET` | `/api/graph` | full snapshot for the visualisation |
| `GET` | `/api/queries` | every Cypher statement the app can run |

---

## How the pipeline works

**Ingest.** Each document becomes a `:Source`. Gemini extracts up to six
self-contained claims, each with its kind, confidence, entities, and, crucially, which other claims
it was *derived from*. The extraction prompt is given the
claims already in the graph, so a document can declare that its conclusion rests
on a fact established by an earlier document. That is what builds chains across
document boundaries. Claims are then `MERGE`d on their content hash, entity
nodes wired, derivation edges written, and newly added claims checked for
contradictions against existing claims about the same entities.

**Ask.** The question is resolved to entity nodes (model-extracted mentions
matched on the indexed key, plus token overlap against entity names). From those
seeds, `RETRIEVE_CONTEXT` walks the graph and returns only claims that still
stand. Gemini synthesises an answer and must declare which claim ids it relied
on; ids it invents are discarded. Those surviving ids become `BASED_ON` edges
from a new `:Answer` node - so the answer's provenance is itself in the graph
and can be invalidated later. `WHY_PATHS` then produces the explanation.

**Retract.** Setting `retracted` on a source *or* on a single claim triggers the
same fixpoint: clear taint, mark the two kinds of root (beliefs withdrawn
directly, and claims whose every stating source is now retracted), propagate one
hop at a time until nothing changes, then recompute answer staleness. Because
both kinds of withdrawal funnel through one recomputation, they compose - you
can retract a document and a claim it shares with another document, and the
cascade accounts for both at once. Recomputing from scratch each time also makes
the operation idempotent and makes **restore** fall out for free: un-retract
something and every belief that deserves to come back, does.

---

## What I'd build next

- **Per-tenant graphs.** FalkorDB holds thousands of isolated graphs in one
  instance, so `selectGraph(tenantId)` gives every user a private memory with no
  schema change. The code already routes through one `graph()` accessor.
- **Temporal validity** on claims (`validFrom`/`validUntil`) so superseded facts
  expire instead of needing manual retraction.
- **Trust-weighted collapse** instead of binary: propagate a confidence penalty
  along `DERIVED_FROM` using edge weights, rather than a boolean taint.
- **MCP server** exposing `ask`, `blast_radius` and `retract` as tools, so any
  MCP-capable agent can use Recant as its memory.

---

## Notes for judges

- **Data.** Every document in `data/corpus.js` is synthetic, written for this
  demo. Northwind Commerce, its services and its people are invented. No
  private, personal, scraped or paywalled data is used anywhere.
- **AI assistance disclosure.** Claude Code was used as a coding assistant
  during the hackathon for implementation and the write-up. The graph model, the
  retraction semantics (corroboration survival, fixpoint propagation, answer
  staleness), the demo scenario and the architecture are my own design
  decisions, and I can explain and defend every query in `src/queries.js`.
- **New work.** The FalkorDB implementation, the schema, all Cypher, the agent
  pipeline and the UI were written during the event window. Dependencies are
  limited to Express, dotenv and the official `falkordb` client.

## License

MIT
