import crypto from 'node:crypto';
import { q, one } from './db.js';
import { genJSON, llmAvailable, modelInUse } from './llm.js';
import * as Q from './queries.js';
import { entityKey } from './ingest.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'can', 'did', 'does', 'was', 'were', 'our', 'we',
  'you', 'they', 'what', 'why', 'how', 'when', 'who', 'is', 'it', 'to', 'of',
  'on', 'in', 'at', 'a', 'an', 'do', 'be', 'with', 'about', 'that', 'this',
  'ready', 'should', 'will', 'have', 'has', 'any', 'all', 'from',
]);

function tokenize(text) {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 12);
}

const MENTION_SYSTEM = `Extract the named things a question is about.
Return JSON only: {"mentions":["Checkout API","Black Friday"]}
Use canonical names (services, teams, people, events, metrics, vendors).
Do not include generic words like "capacity" or "plan" unless they are part of a name.`;

async function resolveSeeds(question) {
  const seeds = new Map();
  const trace = [];

  // 1. Model-extracted mentions, matched on the indexed entity key.
  if (llmAvailable()) {
    try {
      const out = await genJSON({
        system: MENTION_SYSTEM,
        prompt: question,
        temperature: 0,
      });
      const keys = (out?.mentions ?? []).map(entityKey).filter(Boolean);
      if (keys.length) {
        const rows = await q('agent.entitiesByKey', Q.MATCH_ENTITIES_BY_KEY, { keys });
        rows.forEach((r) => seeds.set(r.key, r.name));
        trace.push({ step: 'mentions', mentions: out?.mentions ?? [], matched: rows.length });
      }
    } catch (err) {
      trace.push({ step: 'mentions', error: String(err?.message || err) });
    }
  }

  // 2. Token overlap against entity names, so a question phrased differently
  //    still lands on the right part of the graph.
  const tokens = tokenize(question);
  if (tokens.length) {
    const rows = await q('agent.entitiesByToken', Q.MATCH_ENTITIES_BY_TOKEN, { tokens });
    rows.forEach((r) => seeds.set(r.key, r.name));
    trace.push({ step: 'tokens', tokens, matched: rows.length });
  }

  return { seeds: [...seeds.keys()], names: [...seeds.values()], trace };
}

async function retrieve(question) {
  const { seeds, names, trace } = await resolveSeeds(question);

  let context = [];
  if (seeds.length) {
    context = await q('agent.retrieveContext', Q.RETRIEVE_CONTEXT, { seeds });
    trace.push({ step: 'traverse', seeds: names, claims: context.length });
  }

  // Fallback: full-text over claim text when no entity anchored the question.
  if (context.length === 0) {
    const tokens = tokenize(question);
    if (tokens.length) {
      try {
        const ft = await q('agent.searchClaims', Q.SEARCH_CLAIMS, {
          text: `(${tokens.join('|')})`,
        });
        context = ft.map((r) => ({ ...r, sources: [], sourceIds: [], entities: [], contradictedBy: [] }));
        trace.push({ step: 'fulltext', claims: context.length });
      } catch (err) {
        trace.push({ step: 'fulltext', error: String(err?.message || err) });
      }
    }
  }

  return { context, seeds: names, trace };
}

const ANSWER_SYSTEM = `You answer from a memory graph, and only from it.

You are given CLAIMS the graph currently considers valid. Claims the graph has
retracted were removed before you saw them - you never learn why, you simply
do not have them any more.

Return JSON only:
{"answer":"2-4 sentences, direct, no hedging filler",
 "verdict":"yes" | "no" | "unknown",
 "confidence":0.0-1.0,
 "used":["c_...","c_..."],
 "caveats":"one clause, or empty string"}

Rules:
- Use ONLY the given claims. Never add outside knowledge.
- "used" must list the claim ids you actually relied on, copied exactly as they
  appear after "id=" (they look like c_1a2b3c4d5e6f). Not the bracket numbers,
  not the claim text. Be exact and complete: this list becomes the recorded
  provenance of your answer, and it is what later tells us this answer is no
  longer trustworthy. An id you did not actually use is a false citation.
- If the claims do not settle the question, say so plainly, set verdict
  "unknown", and explain what is missing. Do not guess to be helpful.
- If a claim is marked CONTRADICTED BY, address the conflict and say which
  side you went with and why (prefer more recent, directly measured evidence).`;

function formatContext(context) {
  return context
    .map((c, i) => {
      const bits = [`[${i + 1}] id=${c.id} (${c.kind}, confidence ${c.confidence})`, c.text];
      if (c.sources?.length) bits.push(`  stated by: ${c.sources.filter(Boolean).join('; ')}`);
      if (c.entities?.length) bits.push(`  about: ${c.entities.filter(Boolean).join(', ')}`);
      if (c.contradictedBy?.filter(Boolean).length) {
        bits.push(`  CONTRADICTED BY: ${c.contradictedBy.filter(Boolean).join(' | ')}`);
      }
      return bits.join('\n');
    })
    .join('\n\n');
}

function fallbackAnswer(context) {
  if (context.length === 0) {
    return {
      answer:
        'Nothing in memory currently supports an answer to this. Either it was never ingested, or every claim that covered it has been retracted.',
      verdict: 'unknown',
      confidence: 0.2,
      used: [],
      caveats: 'no LLM configured; this is a graph-only response',
    };
  }
  return {
    answer: `Memory holds ${context.length} valid claim(s) on this: ` +
      context.slice(0, 3).map((c) => c.text).join(' | '),
    verdict: 'unknown',
    confidence: 0.4,
    used: context.slice(0, 5).map((c) => c.id),
    caveats: 'no LLM configured; claims returned without synthesis',
  };
}

/**
 * Fallback provenance: score each retrieved claim by how much of its wording
 * the answer actually reuses, and keep only claims with real overlap. Returns
 * an empty list rather than guessing when nothing matches.
 */
function claimsMatchingAnswer(answer, context, limit) {
  const answerWords = new Set(
    String(answer)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
  if (answerWords.size === 0) return [];

  return context
    .map((c) => {
      const words = new Set(
        String(c.text)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
      );
      if (words.size === 0) return { id: c.id, score: 0 };
      let shared = 0;
      for (const w of words) if (answerWords.has(w)) shared += 1;
      return { id: c.id, score: shared / words.size };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.id);
}

/** Group the raw WHY_PATHS rows into one explanation per claim. */
function shapeWhyPaths(rows) {
  const byClaim = new Map();
  for (const r of rows) {
    if (!byClaim.has(r.claimId)) {
      byClaim.set(r.claimId, { claimId: r.claimId, claimText: r.claimText, chains: [] });
    }
    const entry = byClaim.get(r.claimId);
    entry.chains.push({
      hops: r.hops ?? 0,
      chainTexts: (r.chainTexts ?? []).filter(Boolean),
      baseId: r.baseId,
      baseText: r.baseText,
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      sourceKind: r.sourceKind,
      sourceRetracted: r.sourceRetracted ?? false,
    });
  }
  for (const entry of byClaim.values()) {
    entry.chains.sort((a, b) => a.hops - b.hops);
    entry.depth = entry.chains.at(-1)?.hops ?? 0;
    entry.sources = [
      ...new Map(
        entry.chains
          .filter((c) => c.sourceId)
          .map((c) => [c.sourceId, { id: c.sourceId, title: c.sourceTitle, kind: c.sourceKind, retracted: c.sourceRetracted }]),
      ).values(),
    ];
  }
  return [...byClaim.values()];
}

export async function ask(question, { sessionId = 'default', remember = true } = {}) {
  const started = Date.now();
  const at = new Date().toISOString();
  const questionId = 'q_' + crypto.randomBytes(6).toString('hex');

  const { context, seeds, trace } = await retrieve(question);

  let result;
  if (llmAvailable()) {
    try {
      result = await genJSON({
        system: ANSWER_SYSTEM,
        prompt: `QUESTION: ${question}\n\nCLAIMS CURRENTLY VALID IN MEMORY:\n${
          context.length ? formatContext(context) : '(memory holds nothing relevant)'
        }`,
        temperature: 0.2,
      });
    } catch (err) {
      trace.push({ step: 'synthesize', error: String(err?.message || err) });
    }
  }
  if (!result?.answer) result = fallbackAnswer(context);

  // Only ids that really exist in the retrieved context become provenance.
  // A model that invents or mangles an id must not get credit for it: the
  // BASED_ON edges written here are what later decides whether this answer
  // goes stale, so a wrong edge is worse than a missing one.
  const valid = new Set(context.map((c) => c.id));
  let used = [...new Set((result.used ?? []).filter((id) => valid.has(id)))];

  if (used.length === 0 && context.length > 0 && result.verdict !== 'unknown') {
    // Recover provenance by matching the answer's own wording against the
    // claims it was given, rather than attributing it to arbitrary claims.
    used = claimsMatchingAnswer(result.answer, context, 3);
    trace.push({ step: 'provenance-recovery', recovered: used.length });
  }

  const whyRows = used.length ? await q('agent.whyPaths', Q.WHY_PATHS, { claimIds: used }) : [];
  const why = shapeWhyPaths(whyRows);

  let answerId = null;
  if (remember) {
    answerId = 'a_' + crypto.randomBytes(6).toString('hex');
    await one('agent.recordQuestion', Q.RECORD_QUESTION, {
      sessionId,
      questionId,
      text: question,
      at,
    });
    await one('agent.recordAnswer', Q.RECORD_ANSWER, {
      questionId,
      answerId,
      text: result.answer,
      at,
      claimIds: used,
    });
  }

  return {
    questionId,
    answerId,
    question,
    answer: result.answer,
    verdict: result.verdict ?? 'unknown',
    confidence: result.confidence ?? 0.5,
    caveats: result.caveats ?? '',
    used,
    why,
    seeds,
    contextSize: context.length,
    context: context.map((c) => ({
      id: c.id,
      text: c.text,
      kind: c.kind,
      sources: (c.sources ?? []).filter(Boolean),
      contradictedBy: (c.contradictedBy ?? []).filter(Boolean),
    })),
    trace,
    model: llmAvailable() ? modelInUse() : null,
    ms: Date.now() - started,
  };
}
