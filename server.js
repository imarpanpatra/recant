import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { q, one, health, GRAPH_NAME } from './src/db.js';
import * as Q from './src/queries.js';
import { ask } from './src/agent.js';
import { ingestAll, ingestDocument } from './src/ingest.js';
import { setRetracted, blastRadius, claimBlastRadius, recomputeTaint, loadBearing } from './src/retract.js';
import { llmAvailable, modelInUse } from './src/llm.js';
import { CORPUS, PHASE1, PHASE2 } from './data/corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[api]', err);
    res.status(err.status || 500).json({ error: String(err?.message || err) });
  });
};

// --- status ----------------------------------------------------------------

app.get('/api/health', wrap(async (_req, res) => {
  const db = await health();
  res.json({
    ok: db.ok,
    graph: GRAPH_NAME,
    db,
    llm: { configured: llmAvailable(), model: llmAvailable() ? modelInUse() : null },
  });
}));

app.get('/api/stats', wrap(async (_req, res) => {
  const stats = (await one('api.stats', Q.STATS)) || {};
  res.json({
    claims: stats.claims ?? 0,
    tainted: stats.tainted ?? 0,
    sources: stats.sources ?? 0,
    retractedSources: stats.retractedSources ?? 0,
    entities: stats.entities ?? 0,
    answers: stats.answers ?? 0,
    staleAnswers: stats.staleAnswers ?? 0,
  });
}));

// --- seeding ---------------------------------------------------------------

const job = { running: false, done: 0, total: 0, log: [], error: null };

app.get('/api/seed/status', (_req, res) => res.json(job));

/**
 * The corpus is a timeline. `phase: 1` (the default) ingests only the
 * September documents, which is the state in which the agent still believes
 * the load test. `phase: 2` delivers October's incident and postmortem into
 * the existing memory, without wiping it.
 */
app.post('/api/seed', wrap(async (req, res) => {
  if (job.running) return res.status(409).json({ error: 'seed already running', job });

  const phase = Number(req.body?.phase || 1);
  const docs = phase === 2 ? PHASE2 : phase === 0 ? CORPUS : PHASE1;
  const wipe = req.body?.wipe !== false && phase !== 2;

  Object.assign(job, { running: true, done: 0, total: docs.length, log: [], error: null, phase });
  res.json({ started: true, total: docs.length, phase });

  (async () => {
    try {
      if (wipe) await one('api.wipe', Q.WIPE);
      await ingestAll(docs, {
        onProgress: (r) => {
          job.done += 1;
          job.log.push(r);
        },
      });
    } catch (err) {
      job.error = String(err?.message || err);
      console.error('[seed]', err);
    } finally {
      job.running = false;
    }
  })();
}));

app.post('/api/ingest', wrap(async (req, res) => {
  const { title, text, kind, trust } = req.body ?? {};
  if (!title || !text) throw Object.assign(new Error('title and text are required'), { status: 400 });
  const doc = {
    id: 'doc-' + Date.now().toString(36),
    title: String(title).slice(0, 200),
    kind: String(kind || 'note'),
    trust: typeof trust === 'number' ? trust : 0.7,
    text: String(text).slice(0, 8000),
    at: new Date().toISOString(),
  };
  const result = await ingestDocument(doc);
  await recomputeTaint();
  res.json(result);
}));

// --- the agent -------------------------------------------------------------

app.post('/api/ask', wrap(async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) throw Object.assign(new Error('question is required'), { status: 400 });
  res.json(await ask(question, {
    sessionId: String(req.body?.sessionId || 'default'),
    remember: req.body?.remember !== false,
  }));
}));

app.get('/api/answers', wrap(async (_req, res) => {
  res.json(await q('api.answers', Q.LIST_ANSWERS));
}));

// --- retraction ------------------------------------------------------------

app.get('/api/sources', wrap(async (_req, res) => {
  const rows = await q('api.sources', Q.SNAP_SOURCES);
  res.json(rows.map((r) => ({
    id: r.id,
    title: r.label,
    kind: r.kind,
    retracted: r.retracted ?? false,
    trust: r.trust,
    claims: r.claims ?? 0,
  })));
}));

app.get('/api/blast/:sourceId', wrap(async (req, res) => {
  const result = await blastRadius(req.params.sourceId);
  if (!result) throw Object.assign(new Error('unknown source'), { status: 404 });
  res.json(result);
}));

app.get('/api/blast-claim/:claimId', wrap(async (req, res) => {
  const result = await claimBlastRadius(req.params.claimId);
  if (!result) throw Object.assign(new Error('unknown claim'), { status: 404 });
  res.json(result);
}));

/** Retracts either a whole source (`sourceId`) or one belief (`claimId`). */
app.post('/api/retract', wrap(async (req, res) => {
  const sourceId = String(req.body?.sourceId || '');
  const claimId = String(req.body?.claimId || '');
  if (!sourceId && !claimId) {
    throw Object.assign(new Error('sourceId or claimId is required'), { status: 400 });
  }
  res.json(
    await setRetracted(
      claimId ? { claimId } : { sourceId },
      req.body?.retracted !== false,
      req.body?.reason || '',
    ),
  );
}));

app.post('/api/recompute', wrap(async (_req, res) => {
  res.json(await recomputeTaint());
}));

// --- graph views -----------------------------------------------------------

app.get('/api/load-bearing', wrap(async (_req, res) => {
  res.json(await loadBearing());
}));

app.get('/api/contradictions', wrap(async (_req, res) => {
  res.json(await q('api.contradictions', Q.LIST_CONTRADICTIONS));
}));

app.get('/api/graph', wrap(async (_req, res) => {
  const [sources, claims, entities, answers, eStates, eDerived, eAbout, eContra, eBasedOn] =
    await Promise.all([
      q('snap.sources', Q.SNAP_SOURCES),
      q('snap.claims', Q.SNAP_CLAIMS),
      q('snap.entities', Q.SNAP_ENTITIES),
      q('snap.answers', Q.SNAP_ANSWERS),
      q('snap.edges.states', Q.SNAP_EDGES_STATES),
      q('snap.edges.derived', Q.SNAP_EDGES_DERIVED),
      q('snap.edges.about', Q.SNAP_EDGES_ABOUT),
      q('snap.edges.contradicts', Q.SNAP_EDGES_CONTRADICTS),
      q('snap.edges.basedOn', Q.SNAP_EDGES_BASED_ON),
    ]);

  const nodes = [
    ...sources.map((s) => ({
      id: s.id, type: 'Source', label: s.label, kind: s.kind,
      retracted: s.retracted ?? false, claims: s.claims ?? 0,
    })),
    ...claims.map((c) => ({
      id: c.id, type: 'Claim', label: c.label, kind: c.kind,
      tainted: c.tainted ?? false, taintDepth: c.taintDepth,
      taintReason: c.taintReason, confidence: c.confidence,
    })),
    ...entities.map((e) => ({ id: e.id, type: 'Entity', label: e.label, kind: e.kind })),
    ...answers.map((a) => ({
      id: a.id, type: 'Answer', label: a.label, stale: a.stale ?? false,
    })),
  ];

  const known = new Set(nodes.map((n) => n.id));
  const edge = (rows, type) =>
    rows
      .filter((r) => known.has(r.src) && known.has(r.dst))
      .map((r) => ({ source: r.src, target: r.dst, type }));

  res.json({
    nodes,
    edges: [
      ...edge(eStates, 'STATES'),
      ...edge(eDerived, 'DERIVED_FROM'),
      ...edge(eAbout, 'ABOUT'),
      ...edge(eContra, 'CONTRADICTS'),
      ...edge(eBasedOn, 'BASED_ON'),
    ],
  });
}));

// --- demo script endpoint (used by the UI's guided walkthrough) ------------

app.get('/api/demo', wrap(async (_req, res) => {
  const delivered = await one(
    'api.demoPhase',
    'MATCH (s:Source) WHERE s.id IN $ids RETURN count(s) AS n',
    { ids: PHASE2.map((d) => d.id) },
  );
  res.json({
    question: 'Are we ready for Black Friday on the current Checkout API setup?',
    octoberDelivered: (delivered?.n ?? 0) > 0,
    octoberDocs: PHASE2.map((d) => d.title),
    reason:
      'Postmortem INC-4412 found the September load test ran on a 10x-smaller, cache-warmed dataset. Its numbers do not transfer to production.',
  });
}));

app.get('/api/queries', (_req, res) => {
  res.json(Object.fromEntries(Object.entries(Q).filter(([, v]) => typeof v === 'string')));
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Recant listening on http://localhost:${port}`);
  console.log(`graph=${GRAPH_NAME} llm=${llmAvailable() ? modelInUse() : 'not configured'}`);
});
