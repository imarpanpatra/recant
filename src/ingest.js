import crypto from 'node:crypto';
import { q, one } from './db.js';
import { genJSON, llmAvailable } from './llm.js';
import * as Q from './queries.js';
import { recomputeTaint } from './retract.js';

export function claimId(text) {
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  return 'c_' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

export function entityKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const FILLER = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'for', 'is', 'are', 'was', 'were', 'behind', 'with']);

function contentWords(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !FILLER.has(w)),
  );
}

/**
 * True when two claims are substantially the same assertion. Used to reject
 * derivation edges between a fact and a restatement of that fact: one source
 * repeating another is corroboration, and treating it as inference would let a
 * retraction cascade through a still-vouched-for fact.
 */
export function restatesSameFact(a, b, threshold = 0.7) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size === 0 || B.size === 0) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  const jaccard = shared / (A.size + B.size - shared);
  return jaccard >= threshold;
}

const EXTRACT_SYSTEM = `You turn documents into a provenance graph for an agent's memory.

Return JSON only, shaped:
{"claims":[{
  "ref":"r1",
  "text":"one self-contained assertion, under 140 chars, no pronouns",
  "kind":"fact" | "measurement" | "decision" | "inference" | "policy",
  "confidence":0.0-1.0,
  "entities":[{"name":"Checkout API","type":"service|team|person|event|metric|vendor|system"}],
  "derived_from":["r2","c_ab12cd34ef56"],
  "rationale":"why this claim depends on those, one short clause"
}]}

Rules:
- Split compound statements into separate claims.
- kind "inference" or "decision" means the document is CONCLUDING something from
  other claims. Those MUST list derived_from. A raw observation has derived_from [].
- derived_from entries are either a "ref" from this same document or an existing
  claim id (starting with c_) from the EXISTING CLAIMS list you are given.
- Never invent an id that is not in this document or that list.
- Entity names must be the canonical name used across documents, not a pronoun.
- Extract at most 6 claims per document. Prefer the load-bearing ones.

CORROBORATION IS NOT INFERENCE. This matters more than anything else here:
- If this document asserts a fact that is ALREADY in the EXISTING CLAIMS list,
  emit it with that claim's text copied EXACTLY, character for character, and
  derived_from []. Reusing the exact text is what records that a second,
  independent source confirms the fact.
- Never add a derived_from edge between two claims that say the same thing.
  Restating a fact is corroboration; only a genuinely new conclusion that
  REASONS FROM a fact is a derivation.`;

/** Claims already in the graph that this document might build on. */
async function existingClaimsContext(limit = 40) {
  const rows = await q('ingest.existingClaims', Q.EXISTING_CLAIMS, { limit });
  return rows.map((r) => `${r.id} :: ${r.text} [${(r.entities || []).join(', ')}]`);
}

/** Crude fallback so the demo still works without an API key. */
function fallbackExtract(doc) {
  const sentences = doc.text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*#>\s]+/, '').trim())
    .filter((s) => s.length > 25 && s.length < 220);

  return {
    claims: sentences.slice(0, 5).map((text, i) => ({
      ref: `r${i + 1}`,
      text,
      kind: 'fact',
      confidence: 0.5,
      entities: (text.match(/\b[A-Z][a-zA-Z0-9-]{2,}(?:\s[A-Z][a-zA-Z0-9-]{2,})?/g) || [])
        .slice(0, 3)
        .map((name) => ({ name, type: 'system' })),
      derived_from: [],
      rationale: '',
    })),
  };
}

async function extract(doc) {
  if (!llmAvailable()) return fallbackExtract(doc);

  const existing = await existingClaimsContext();
  const prompt = [
    'EXISTING CLAIMS (you may reference these ids in derived_from):',
    existing.length ? existing.join('\n') : '(none yet)',
    '',
    `DOCUMENT id=${doc.id} kind=${doc.kind} title=${doc.title}`,
    doc.text,
  ].join('\n');

  const out = await genJSON({ system: EXTRACT_SYSTEM, prompt, temperature: 0.1 });
  if (!out || !Array.isArray(out.claims) || out.claims.length === 0) {
    console.warn(`[ingest] extraction returned nothing for ${doc.id}, falling back`);
    return fallbackExtract(doc);
  }
  return out;
}

const CONTRADICTION_SYSTEM = `You detect conflicts between claims in an agent's memory.

Return JSON only:
{"pairs":[{"a":"<claim id>","b":"<claim id>","conflict":true,"note":"why they conflict, one clause"}]}

Only include a pair when conflict is true. If you find yourself writing a note
that explains the pair is compatible, leave the pair out entirely.

Flag a pair when any of these hold:
1. Both cannot be true of the same subject at the same time - different
   measured values for the same metric, opposite decisions, a statement and
   its denial.
2. One claim INVALIDATES the other: it says the other's figure, test or
   method was wrong, does not transfer, was measured under unrepresentative
   conditions, or must not be relied on.
3. One claim reports real-world behaviour that is inconsistent with what
   another claim predicted or guaranteed.

Example of (2): "The September figure of 1200 rps does not transfer to
production" conflicts with "The team considers 1200 rps the safe sustained
ceiling" - the first withdraws the ground the second stands on.

Related-but-compatible claims are NOT conflicts. Use the exact ids given.
Return {"pairs":[]} when there is no genuine conflict.`;

async function detectContradictions(newClaims) {
  if (!llmAvailable() || newClaims.length === 0) return 0;

  const blocks = [];
  for (const c of newClaims) {
    const candidates = await q('ingest.contradictionCandidates', Q.CONTRADICTION_CANDIDATES, {
      claimId: c.id,
    });
    if (candidates.length === 0) continue;
    blocks.push(
      [
        `NEW CLAIM ${c.id} :: ${c.text}`,
        'CANDIDATES:',
        ...candidates.map((x) => `  ${x.id} :: ${x.text}`),
      ].join('\n'),
    );
  }
  if (blocks.length === 0) return 0;

  const out = await genJSON({
    system: CONTRADICTION_SYSTEM,
    prompt: blocks.join('\n\n'),
    temperature: 0,
  });

  // Texts for the near-duplicate guard: a claim and a restatement of it are
  // corroboration, never a conflict, whatever the model decided.
  const ids = [...new Set((out?.pairs ?? []).flatMap((p) => [p?.a, p?.b]).filter(Boolean))];
  const textById = new Map(
    ids.length ? (await q('ingest.pairTexts', Q.CLAIM_TEXTS, { ids })).map((r) => [r.id, r.text]) : [],
  );

  let linked = 0;
  for (const pair of out?.pairs ?? []) {
    if (!pair?.a || !pair?.b || pair.a === pair.b) continue;
    if (pair.conflict === false) continue;
    if (restatesSameFact(textById.get(pair.a), textById.get(pair.b))) {
      console.log('[ingest] rejected a "contradiction" between two restatements of one fact');
      continue;
    }
    // LINK_CONTRADICTS matches both claims, so a model-invented id writes no
    // edge. Count what the graph actually gained, not what was proposed.
    const rows = await q('ingest.linkContradicts', Q.LINK_CONTRADICTS, {
      aId: pair.a,
      bId: pair.b,
      note: String(pair.note || '').slice(0, 300),
    });
    if (rows.length) linked += 1;
  }
  return linked;
}

/**
 * Ingest one document: write the Source, MERGE each claim (so repeated facts
 * converge and gain a second STATES edge), wire entities, then wire the
 * derivation edges that make retraction meaningful later.
 */
export async function ingestDocument(doc) {
  const at = doc.at || new Date().toISOString();
  await one('ingest.upsertSource', Q.UPSERT_SOURCE, {
    id: doc.id,
    title: doc.title,
    kind: doc.kind || 'document',
    text: doc.text,
    trust: typeof doc.trust === 'number' ? doc.trust : 0.7,
    at,
  });

  const extracted = await extract(doc);
  const refToId = new Map();
  const written = [];

  for (const c of extracted.claims) {
    const text = String(c.text || '').trim();
    if (!text) continue;
    const id = claimId(text);
    refToId.set(c.ref || id, id);

    await one('ingest.upsertClaim', Q.UPSERT_CLAIM, {
      id,
      text,
      kind: c.kind || 'fact',
      confidence: typeof c.confidence === 'number' ? c.confidence : 0.6,
      at,
      sourceId: doc.id,
    });

    for (const e of c.entities ?? []) {
      const name = String(e?.name || '').trim();
      if (!name) continue;
      await one('ingest.linkEntity', Q.LINK_ENTITY, {
        key: entityKey(name),
        name,
        type: e?.type || 'system',
        claimId: id,
      });
    }

    written.push({ id, text, derived_from: c.derived_from ?? [], rationale: c.rationale || '' });
  }

  // Derivation edges are wired after all claims exist, so intra-document refs
  // resolve regardless of the order the model emitted them in.
  //
  // Every candidate edge is checked against a deterministic near-duplicate
  // guard first. An extractor that links "X runs on 3 nodes" to another
  // document's "X runs on 3 nodes" has mistaken corroboration for inference,
  // and that single bad edge would make a retraction cascade through a fact
  // that an independent source still vouches for. The graph must not depend
  // on the model getting this right.
  const parentIds = [
    ...new Set(
      written.flatMap((c) =>
        c.derived_from
          .map((ref) => refToId.get(ref) || (String(ref).startsWith('c_') ? String(ref) : null))
          .filter(Boolean),
      ),
    ),
  ];
  const textById = new Map(written.map((c) => [c.id, c.text]));
  const unknown = parentIds.filter((id) => !textById.has(id));
  if (unknown.length) {
    const rows = await q('ingest.parentTexts', Q.CLAIM_TEXTS, { ids: unknown });
    rows.forEach((r) => textById.set(r.id, r.text));
  }

  let edges = 0;
  let rejected = 0;
  for (const c of written) {
    for (const ref of c.derived_from) {
      const parentId = refToId.get(ref) || (String(ref).startsWith('c_') ? String(ref) : null);
      if (!parentId || parentId === c.id) continue;

      if (restatesSameFact(c.text, textById.get(parentId))) {
        rejected += 1;
        continue;
      }

      const res = await one('ingest.linkDerived', Q.LINK_DERIVED, {
        childId: c.id,
        parentId,
        rationale: c.rationale.slice(0, 300),
      });
      if (res) edges += 1;
    }
  }
  if (rejected) {
    console.log(`[ingest] ${doc.id}: rejected ${rejected} derivation(s) that only restated a claim`);
  }

  const contradictions = await detectContradictions(written);

  return {
    source: doc.id,
    title: doc.title,
    claims: written.length,
    derivations: edges,
    contradictions,
  };
}

export async function ingestAll(docs, { onProgress } = {}) {
  const results = [];
  for (const doc of docs) {
    const r = await ingestDocument(doc);
    results.push(r);
    onProgress?.(r);
    console.log(
      `[ingest] ${r.source}: ${r.claims} claims, ${r.derivations} derivations, ${r.contradictions} contradictions`,
    );
  }
  // A fresh ingest can attach new claims under an already-retracted source.
  await recomputeTaint();
  return results;
}
