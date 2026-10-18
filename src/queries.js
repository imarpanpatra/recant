/**
 * Every Cypher statement Recant depends on, in one file.
 *
 * The product is a memory layer, and the memory is the graph: retrieval,
 * explanation and retraction are all traversals. Nothing here can be replaced
 * by a key-value or vector lookup, because every operation is about the
 * *edges* between claims, not the claims themselves.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
// Nodes
//   (:Source  {id, title, kind, text, trust, retracted, retractedAt})
//   (:Claim   {id, text, kind, confidence, tainted, taintDepth, taintReason})
//   (:Entity  {key, name, type})
//   (:Session {id, startedAt})
//   (:Question{id, text, askedAt})
//   (:Answer  {id, text, at, stale, staleReason})
// Edges
//   (:Source)-[:STATES]->(:Claim)          a document asserts a claim
//   (:Claim)-[:DERIVED_FROM]->(:Claim)     inference: child depends on parent
//   (:Claim)-[:SUPPORTS]->(:Claim)         corroboration, non-load-bearing
//   (:Claim)-[:CONTRADICTS]-(:Claim)       mutual conflict
//   (:Claim)-[:ABOUT]->(:Entity)           what the claim is about
//   (:Answer)-[:BASED_ON]->(:Claim)        provenance of a past answer
//   (:Answer)-[:ANSWERS]->(:Question)
//   (:Question)-[:IN_SESSION]->(:Session)

export const SCHEMA_STATEMENTS = [
  'CREATE INDEX FOR (s:Source) ON (s.id)',
  'CREATE INDEX FOR (c:Claim) ON (c.id)',
  'CREATE INDEX FOR (c:Claim) ON (c.tainted)',
  'CREATE INDEX FOR (e:Entity) ON (e.key)',
  'CREATE INDEX FOR (a:Answer) ON (a.id)',
  'CREATE INDEX FOR (q:Question) ON (q.id)',
  'CREATE FULLTEXT INDEX FOR (e:Entity) ON (e.name)',
  'CREATE FULLTEXT INDEX FOR (c:Claim) ON (c.text)',
];

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const UPSERT_SOURCE = `
MERGE (s:Source {id: $id})
SET s.title = $title,
    s.kind = $kind,
    s.text = $text,
    s.trust = $trust,
    s.at = $at,
    s.retracted = coalesce(s.retracted, false)
RETURN s.id AS id`;

/**
 * Claims are MERGEd on a content hash, so two documents asserting the same
 * fact converge on one node with two STATES edges. That is what makes
 * corroboration real: retracting one source does not kill a claim another
 * source still supports.
 */
export const UPSERT_CLAIM = `
MERGE (c:Claim {id: $id})
SET c.text = $text,
    c.kind = $kind,
    c.confidence = $confidence,
    c.at = $at,
    c.tainted = coalesce(c.tainted, false)
WITH c
MATCH (s:Source {id: $sourceId})
MERGE (s)-[:STATES]->(c)
RETURN c.id AS id`;

export const LINK_ENTITY = `
MERGE (e:Entity {key: $key})
SET e.name = $name, e.type = $type
WITH e
MATCH (c:Claim {id: $claimId})
MERGE (c)-[:ABOUT]->(e)
RETURN e.key AS key`;

export const LINK_DERIVED = `
MATCH (child:Claim {id: $childId}), (parent:Claim {id: $parentId})
WHERE child.id <> parent.id
MERGE (child)-[r:DERIVED_FROM]->(parent)
SET r.rationale = $rationale
RETURN parent.id AS parentId`;

export const LINK_SUPPORTS = `
MATCH (a:Claim {id: $fromId}), (b:Claim {id: $toId})
WHERE a.id <> b.id
MERGE (a)-[:SUPPORTS]->(b)
RETURN b.id AS toId`;

export const LINK_CONTRADICTS = `
MATCH (a:Claim {id: $aId}), (b:Claim {id: $bId})
WHERE a.id <> b.id
MERGE (a)-[r:CONTRADICTS]->(b)
SET r.note = $note
RETURN b.id AS bId`;

/**
 * Claims already in the graph, shown to the extractor so a new document can
 * declare that its conclusion rests on a fact an earlier document established.
 * This is what builds derivation chains across document boundaries.
 */
export const EXISTING_CLAIMS = `
MATCH (c:Claim)
OPTIONAL MATCH (c)-[:ABOUT]->(e:Entity)
RETURN c.id AS id, c.text AS text, c.at AS at, collect(DISTINCT e.name) AS entities
ORDER BY at DESC
LIMIT $limit`;

/** Text lookup for claims referenced by id, used by the near-duplicate guard. */
export const CLAIM_TEXTS = `
UNWIND $ids AS cid
MATCH (c:Claim {id: cid})
RETURN c.id AS id, c.text AS text`;

/** Candidate claims for contradiction checking: same entity, different claim. */
export const CONTRADICTION_CANDIDATES = `
MATCH (c:Claim {id: $claimId})-[:ABOUT]->(e:Entity)<-[:ABOUT]-(other:Claim)
WHERE other.id <> c.id AND coalesce(other.retracted, false) = false
RETURN DISTINCT other.id AS id, other.text AS text
LIMIT 12`;

// ---------------------------------------------------------------------------
// Retrieval - multi-hop, taint-aware
// ---------------------------------------------------------------------------

/** Resolve question text to entities via the full-text index. */
export const RESOLVE_ENTITIES = `
CALL db.idx.fulltext.queryNodes('Entity', $text) YIELD node, score
RETURN node.key AS key, node.name AS name, node.type AS type, score
ORDER BY score DESC
LIMIT 12`;

/** Exact lookup for entity names the model pulled out of the question. */
export const MATCH_ENTITIES_BY_KEY = `
UNWIND $keys AS k
MATCH (e:Entity {key: k})
RETURN e.key AS key, e.name AS name, e.type AS type`;

/**
 * Token overlap against entity names, so a question phrased in the user's own
 * words still anchors on the right region of the graph.
 */
export const MATCH_ENTITIES_BY_TOKEN = `
UNWIND $tokens AS t
MATCH (e:Entity)
WHERE toLower(e.name) CONTAINS t
WITH DISTINCT e
MATCH (e)<-[:ABOUT]-(c:Claim)
RETURN e.key AS key, e.name AS name, e.type AS type, count(c) AS claims
ORDER BY claims DESC
LIMIT 10`;

/** Fallback when no entity matches: full-text over claim text. */
export const SEARCH_CLAIMS = `
CALL db.idx.fulltext.queryNodes('Claim', $text) YIELD node, score
WITH node AS c, score
WHERE coalesce(c.tainted, false) = false AND coalesce(c.retracted, false) = false
RETURN c.id AS id, c.text AS text, c.kind AS kind, c.confidence AS confidence, score
ORDER BY score DESC
LIMIT 20`;

/**
 * The retrieval traversal. Seeds on entities the question mentions, then walks
 * up to 3 hops along DERIVED_FROM to pull in the reasoning each seed claim
 * rests on - so the agent sees not just the conclusion but what it stands on.
 * Tainted and retracted claims are excluded at every hop.
 */
export const RETRIEVE_CONTEXT = `
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
RETURN c.id AS id,
       c.text AS text,
       c.kind AS kind,
       c.confidence AS confidence,
       c.at AS at,
       collect(DISTINCT src.title) AS sources,
       collect(DISTINCT src.id) AS sourceIds,
       collect(DISTINCT ent.name) AS entities,
       collect(DISTINCT conf.text) AS contradictedBy
LIMIT 60`;

/**
 * The "why" traversal: for each claim an answer used, walk every derivation
 * chain back to the documents that originally asserted it. This is the
 * explanation the user sees, and it is a path query - there is no
 * non-graph shortcut to it.
 */
export const WHY_PATHS = `
UNWIND $claimIds AS cid
MATCH (c:Claim {id: cid})
OPTIONAL MATCH p = (c)-[:DERIVED_FROM*0..4]->(base:Claim)
WITH c, base, p, length(p) AS hops
OPTIONAL MATCH (src:Source)-[:STATES]->(base)
RETURN c.id AS claimId,
       c.text AS claimText,
       hops AS hops,
       [n IN nodes(p) | n.id] AS chainIds,
       [n IN nodes(p) | n.text] AS chainTexts,
       base.id AS baseId,
       base.text AS baseText,
       src.id AS sourceId,
       src.title AS sourceTitle,
       src.kind AS sourceKind,
       coalesce(src.retracted, false) AS sourceRetracted
ORDER BY hops ASC
LIMIT 120`;

// ---------------------------------------------------------------------------
// Answer memory
// ---------------------------------------------------------------------------

export const RECORD_QUESTION = `
MERGE (ses:Session {id: $sessionId})
SET ses.startedAt = coalesce(ses.startedAt, $at)
CREATE (q:Question {id: $questionId, text: $text, askedAt: $at})
CREATE (q)-[:IN_SESSION]->(ses)
RETURN q.id AS id`;

export const RECORD_ANSWER = `
MATCH (q:Question {id: $questionId})
CREATE (a:Answer {id: $answerId, text: $text, at: $at, stale: false})
CREATE (a)-[:ANSWERS]->(q)
WITH a
UNWIND $claimIds AS cid
MATCH (c:Claim {id: cid})
MERGE (a)-[:BASED_ON]->(c)
RETURN a.id AS id`;

export const LIST_ANSWERS = `
MATCH (a:Answer)-[:ANSWERS]->(q:Question)
OPTIONAL MATCH (a)-[:BASED_ON]->(c:Claim)
RETURN a.id AS id,
       a.text AS text,
       a.at AS at,
       coalesce(a.stale, false) AS stale,
       a.staleReason AS staleReason,
       q.text AS question,
       count(c) AS claimCount,
       sum(CASE WHEN coalesce(c.tainted, false) THEN 1 ELSE 0 END) AS taintedClaims
ORDER BY a.at DESC
LIMIT 20`;

// ---------------------------------------------------------------------------
// Retraction - the core of the product
// ---------------------------------------------------------------------------

export const SET_SOURCE_RETRACTED = `
MATCH (s:Source {id: $sourceId})
SET s.retracted = $retracted,
    s.retractedAt = CASE WHEN $retracted THEN $at ELSE null END,
    s.retractedReason = CASE WHEN $retracted THEN $reason ELSE null END
RETURN s.id AS id, s.title AS title, coalesce(s.retracted, false) AS retracted`;

/**
 * Read-only blast radius: if this source were retracted, how far would the
 * damage reach? One variable-length traversal walks the whole downstream
 * cone of inference, up to 8 hops.
 */
export const BLAST_RADIUS = `
MATCH (s:Source {id: $sourceId})
OPTIONAL MATCH (s)-[:STATES]->(root:Claim)
WITH s, [x IN collect(DISTINCT root) WHERE x IS NOT NULL] AS roots
OPTIONAL MATCH (d:Claim)-[:DERIVED_FROM*1..8]->(anc:Claim)
WHERE anc IN roots
WITH s, roots, [x IN collect(DISTINCT d) WHERE x IS NOT NULL AND NOT x IN roots] AS derived
OPTIONAL MATCH (a:Answer)-[:BASED_ON]->(ac:Claim)
WHERE ac IN roots OR ac IN derived
RETURN s.title AS title,
       size(roots) AS directClaims,
       size(derived) AS derivedClaims,
       [x IN collect(DISTINCT a.text) WHERE x IS NOT NULL] AS affectedAnswers,
       [x IN roots | x.text] AS rootTexts,
       [x IN derived | x.text] AS derivedTexts`;

/**
 * Retract a claim itself, independently of any document.
 *
 * Source-level retraction is not always enough: a wrong figure gets copied
 * into later documents, so the belief keeps standing on a source nobody has
 * questioned. Retracting the claim withdraws the belief wherever it was
 * asserted from.
 */
export const SET_CLAIM_RETRACTED = `
MATCH (c:Claim {id: $claimId})
SET c.retracted = $retracted,
    c.retractedAt = CASE WHEN $retracted THEN $at ELSE null END,
    c.retractedReason = CASE WHEN $retracted THEN $reason ELSE null END
RETURN c.id AS id, c.text AS title, coalesce(c.retracted, false) AS retracted`;

/** Read-only blast radius for a single claim. */
export const CLAIM_BLAST_RADIUS = `
MATCH (c:Claim {id: $claimId})
OPTIONAL MATCH (d:Claim)-[:DERIVED_FROM*1..8]->(c)
WITH c, [x IN collect(DISTINCT d) WHERE x IS NOT NULL] AS derived
OPTIONAL MATCH (s:Source)-[:STATES]->(c)
WITH c, derived, [x IN collect(DISTINCT s.title) WHERE x IS NOT NULL] AS statedBy
OPTIONAL MATCH (a:Answer)-[:BASED_ON]->(ac:Claim)
WHERE ac = c OR ac IN derived
RETURN c.text AS title,
       1 AS directClaims,
       coalesce(c.retracted, false) AS retracted,
       coalesce(c.tainted, false) AS tainted,
       size(derived) AS derivedClaims,
       statedBy AS statedBy,
       [x IN collect(DISTINCT a.text) WHERE x IS NOT NULL] AS affectedAnswers,
       [c.text] AS rootTexts,
       [x IN derived | x.text] AS derivedTexts`;

// --- taint recomputation (fixpoint, run after any retract/restore) ---

/** A claim retracted directly is a root of the cascade, like a dead source. */
export const TAINT_RETRACTED_CLAIMS = `
MATCH (c:Claim)
WHERE coalesce(c.retracted, false) = true
SET c.tainted = true,
    c.taintDepth = 0,
    c.taintReason = coalesce(c.retractedReason, 'this claim was retracted directly')
RETURN count(c) AS n`;

export const CLEAR_TAINT = `
MATCH (c:Claim)
SET c.tainted = false, c.taintDepth = null, c.taintReason = null
RETURN count(c) AS n`;

/**
 * Step 1: a claim loses its footing only when *every* source that stated it
 * has been retracted. Corroboration survives a single bad document.
 */
export const TAINT_UNSUPPORTED_ROOTS = `
MATCH (src:Source)-[:STATES]->(c:Claim)
WITH c,
     count(src) AS total,
     sum(CASE WHEN coalesce(src.retracted, false) THEN 1 ELSE 0 END) AS retractedCount
WHERE total > 0 AND retractedCount = total AND coalesce(c.tainted, false) = false
SET c.tainted = true,
    c.taintDepth = 0,
    c.taintReason = 'every source that stated this has been retracted'
RETURN count(c) AS n`;

/**
 * Step 2, iterated to a fixpoint: any inference with a tainted parent is
 * itself tainted. Single-hop and repeated, so cycles terminate safely.
 */
export const PROPAGATE_TAINT_ONE_HOP = `
MATCH (d:Claim)-[:DERIVED_FROM]->(p:Claim)
WHERE coalesce(p.tainted, false) = true AND coalesce(d.tainted, false) = false
SET d.tainted = true,
    d.taintDepth = coalesce(p.taintDepth, 0) + 1,
    d.taintReason = 'derived from a retracted claim: ' + p.text
RETURN count(d) AS n`;

export const RESET_ANSWER_STALENESS = `
MATCH (a:Answer)
SET a.stale = false, a.staleReason = null
RETURN count(a) AS n`;

/** An answer standing on a tainted claim is itself no longer trustworthy. */
export const MARK_STALE_ANSWERS = `
MATCH (a:Answer)-[:BASED_ON]->(c:Claim)
WHERE coalesce(c.tainted, false) = true
WITH a, collect(c.text) AS broken
SET a.stale = true,
    a.staleReason = 'relies on ' + toString(size(broken)) + ' retracted claim(s)'
RETURN count(a) AS n`;

export const TAINT_REPORT = `
MATCH (c:Claim)
WHERE coalesce(c.tainted, false) = true
OPTIONAL MATCH (c)-[:ABOUT]->(e:Entity)
RETURN c.id AS id, c.text AS text, c.taintDepth AS depth, c.taintReason AS reason,
       collect(DISTINCT e.name) AS entities
ORDER BY c.taintDepth ASC, c.id ASC`;

// ---------------------------------------------------------------------------
// Graph algorithms as agent tools
// ---------------------------------------------------------------------------

/**
 * PageRank over DERIVED_FROM. Edges point from a conclusion to what it rests
 * on, so incoming weight accumulates on the claims the most reasoning depends
 * on. High score = load-bearing: the belief you would least like to be wrong.
 */
export const LOAD_BEARING_CLAIMS = `
CALL algo.pageRank('Claim', 'DERIVED_FROM') YIELD node, score
WITH node, score
WHERE coalesce(node.tainted, false) = false
OPTIONAL MATCH (src:Source)-[:STATES]->(node)
OPTIONAL MATCH (dependent:Claim)-[:DERIVED_FROM*1..8]->(node)
RETURN node.id AS id,
       node.text AS text,
       score AS score,
       count(DISTINCT dependent) AS dependents,
       [x IN collect(DISTINCT src.title) WHERE x IS NOT NULL] AS sources
ORDER BY score DESC, dependents DESC
LIMIT 8`;

/** Open contradictions the agent had to arbitrate. */
export const LIST_CONTRADICTIONS = `
MATCH (a:Claim)-[r:CONTRADICTS]->(b:Claim)
RETURN a.id AS aId, a.text AS aText, coalesce(a.tainted, false) AS aTainted,
       b.id AS bId, b.text AS bText, coalesce(b.tainted, false) AS bTainted,
       r.note AS note
LIMIT 30`;

// ---------------------------------------------------------------------------
// Snapshot for the UI (split per label to keep each query trivially safe)
// ---------------------------------------------------------------------------

export const SNAP_SOURCES = `
MATCH (s:Source)
OPTIONAL MATCH (s)-[:STATES]->(c:Claim)
RETURN s.id AS id, s.title AS label, s.kind AS kind,
       coalesce(s.retracted, false) AS retracted, s.trust AS trust,
       count(c) AS claims`;

export const SNAP_CLAIMS = `
MATCH (c:Claim)
RETURN c.id AS id, c.text AS label, c.kind AS kind,
       coalesce(c.tainted, false) AS tainted, c.taintDepth AS taintDepth,
       c.taintReason AS taintReason, c.confidence AS confidence`;

export const SNAP_ENTITIES = `
MATCH (e:Entity)<-[:ABOUT]-(c:Claim)
RETURN e.key AS id, e.name AS label, e.type AS kind, count(c) AS claims
ORDER BY claims DESC
LIMIT 40`;

export const SNAP_ANSWERS = `
MATCH (a:Answer)
RETURN a.id AS id, a.text AS label, coalesce(a.stale, false) AS stale, a.at AS at
ORDER BY a.at DESC
LIMIT 10`;

export const SNAP_EDGES_STATES = `
MATCH (s:Source)-[:STATES]->(c:Claim)
RETURN s.id AS src, c.id AS dst`;

export const SNAP_EDGES_DERIVED = `
MATCH (a:Claim)-[:DERIVED_FROM]->(b:Claim)
RETURN a.id AS src, b.id AS dst`;

export const SNAP_EDGES_ABOUT = `
MATCH (c:Claim)-[:ABOUT]->(e:Entity)
RETURN c.id AS src, e.key AS dst`;

export const SNAP_EDGES_CONTRADICTS = `
MATCH (a:Claim)-[:CONTRADICTS]->(b:Claim)
RETURN a.id AS src, b.id AS dst`;

export const SNAP_EDGES_BASED_ON = `
MATCH (a:Answer)-[:BASED_ON]->(c:Claim)
RETURN a.id AS src, c.id AS dst`;

export const STATS = `
MATCH (c:Claim)
WITH count(c) AS claims, sum(CASE WHEN coalesce(c.tainted, false) THEN 1 ELSE 0 END) AS tainted
MATCH (s:Source)
WITH claims, tainted, count(s) AS sources,
     sum(CASE WHEN coalesce(s.retracted, false) THEN 1 ELSE 0 END) AS retractedSources
OPTIONAL MATCH (e:Entity)
WITH claims, tainted, sources, retractedSources, count(DISTINCT e) AS entities
OPTIONAL MATCH (a:Answer)
RETURN claims, tainted, sources, retractedSources, entities,
       count(DISTINCT a) AS answers,
       sum(CASE WHEN coalesce(a.stale, false) THEN 1 ELSE 0 END) AS staleAnswers`;

export const WIPE = `MATCH (n) DETACH DELETE n`;
