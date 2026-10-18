/**
 * Verifies the retraction semantics against a real FalkorDB instance, using a
 * fixed fixture graph built through the same queries the app uses - no LLM
 * involved, so this tests the graph behaviour and nothing else.
 *
 *   node scripts/verify.js
 */
import 'dotenv/config';
import { q, one, close } from '../src/db.js';
import * as Q from '../src/queries.js';
import { claimId, entityKey } from '../src/ingest.js';
import { recomputeTaint, blastRadius, setRetracted, loadBearing } from '../src/retract.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

function checkTrue(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

const now = '2026-10-18T00:00:00Z';

const TEXTS = {
  ceiling: 'Checkout API sustains 1200 rps on 3 nodes',
  nodes: 'Checkout API runs on 3 application nodes in eu-west-1',
  absorb: 'Checkout API can absorb the 900 rps Black Friday peak on 3 nodes',
  noScale: 'Northwind will not scale up Checkout API before Black Friday',
  oneOncall: 'Black Friday weekend is covered by a single on-call engineer',
};
const ID = Object.fromEntries(Object.entries(TEXTS).map(([k, v]) => [k, claimId(v)]));

async function src(id, title) {
  await one('fixture.source', Q.UPSERT_SOURCE, {
    id, title, kind: 'test', text: title, trust: 0.8, at: now,
  });
}

async function claim(key, sourceId, kind = 'fact') {
  await one('fixture.claim', Q.UPSERT_CLAIM, {
    id: ID[key], text: TEXTS[key], kind, confidence: 0.8, at: now, sourceId,
  });
  await one('fixture.entity', Q.LINK_ENTITY, {
    key: entityKey('Checkout API'), name: 'Checkout API', type: 'service', claimId: ID[key],
  });
}

async function derive(childKey, parentKey) {
  await one('fixture.derive', Q.LINK_DERIVED, {
    childId: ID[childKey], parentId: ID[parentKey], rationale: 'fixture',
  });
}

async function taintedIds() {
  const rows = await q('verify.taintReport', Q.TAINT_REPORT);
  return rows.map((r) => r.id).sort();
}

async function taintDepths() {
  const rows = await q('verify.taintReport', Q.TAINT_REPORT);
  return Object.fromEntries(rows.map((r) => [r.id, r.depth]));
}

async function build() {
  await one('verify.wipe', Q.WIPE);

  await src('s-loadtest', 'Load test report');
  await src('s-inventory', 'Infrastructure inventory');
  await src('s-audit', 'Platform audit');
  await src('s-plan', 'Capacity plan');
  await src('s-decision', 'Decision record');
  await src('s-rota', 'On-call rota');

  // One poisoned root, and a chain of three inferences standing on it.
  await claim('ceiling', 's-loadtest', 'measurement');
  await claim('absorb', 's-plan', 'inference');
  await claim('noScale', 's-decision', 'decision');
  await claim('oneOncall', 's-rota', 'decision');
  await derive('absorb', 'ceiling');
  await derive('noScale', 'absorb');
  await derive('oneOncall', 'noScale');

  // One claim asserted independently by two sources.
  await claim('nodes', 's-inventory');
  await claim('nodes', 's-audit');

  await recomputeTaint();
}

try {
  console.log('\nbuilding fixture graph...');
  await build();

  const stats = await one('verify.stats', Q.STATS);
  console.log(`fixture: ${stats.sources} sources, ${stats.claims} claims, ${stats.entities} entities\n`);

  console.log('baseline');
  check('nothing tainted before any retraction', await taintedIds(), []);
  check('claim count', stats.claims, 5);

  const corroboration = await one(
    'verify.statesEdges',
    `MATCH (s:Source)-[:STATES]->(c:Claim {id: $id}) RETURN count(s) AS n`,
    { id: ID.nodes },
  );
  check('corroborated claim has two STATES edges', corroboration.n, 2);

  console.log('\nblast radius (read-only, before mutating)');
  const blast = await blastRadius('s-loadtest');
  check('direct claims', blast.directClaims, 1);
  check('downstream inferences', blast.derivedClaims, 3);
  check('still nothing tainted after a what-if', await taintedIds(), []);

  console.log('\nretract the load test');
  const r1 = await setRetracted('s-loadtest', true, 'invalid test conditions');
  check(
    'cascade taints the root and all three inferences',
    await taintedIds(),
    [ID.ceiling, ID.absorb, ID.noScale, ID.oneOncall].sort(),
  );
  check('propagation took three hops', r1.taint.hops, 3);
  check('hop distances are honest', await taintDepths(), {
    [ID.ceiling]: 0,
    [ID.absorb]: 1,
    [ID.noScale]: 2,
    [ID.oneOncall]: 3,
  });
  checkTrue(
    'corroborated claim survives an unrelated retraction',
    !(await taintedIds()).includes(ID.nodes),
  );

  console.log('\nretrieval hides collapsed claims');
  const ctx = await q('verify.retrieve', Q.RETRIEVE_CONTEXT, { seeds: [entityKey('Checkout API')] });
  const visible = ctx.map((c) => c.id);
  check('only the surviving claim is retrievable', visible, [ID.nodes]);

  console.log('\ncorroboration: retract one of two sources');
  await setRetracted('s-inventory', true, 'superseded');
  checkTrue(
    'claim still stands while the audit asserts it',
    !(await taintedIds()).includes(ID.nodes),
  );
  await setRetracted('s-audit', true, 'superseded');
  checkTrue(
    'claim collapses once every source is retracted',
    (await taintedIds()).includes(ID.nodes),
  );

  console.log('\nrestore is the inverse');
  await setRetracted('s-inventory', false);
  checkTrue(
    'restoring one source brings the claim back',
    !(await taintedIds()).includes(ID.nodes),
  );
  await setRetracted('s-loadtest', false);
  // s-audit is still retracted here, but s-inventory is back, so the
  // corroborated claim stays alive and nothing should be tainted at all.
  check('restoring the root clears the whole cascade', await taintedIds(), []);
  await setRetracted('s-audit', false);
  check('full restore leaves nothing tainted', await taintedIds(), []);

  console.log('\nclaim-level retraction');
  // A wrong figure gets copied into later documents, so retracting any single
  // source can leave the belief standing. Withdrawing the belief must work too.
  await claim('ceiling', 's-plan'); // a second document now also asserts it
  await recomputeTaint();
  await setRetracted('s-loadtest', true, 'invalid test conditions');
  checkTrue(
    'retracting one source leaves a belief a second source still asserts',
    !(await taintedIds()).includes(ID.ceiling),
  );
  await setRetracted({ claimId: ID.ceiling }, true, 'measured on unrepresentative data');
  check(
    'withdrawing the belief itself collapses it and everything downstream',
    await taintedIds(),
    [ID.ceiling, ID.absorb, ID.noScale, ID.oneOncall].sort(),
  );
  await setRetracted({ claimId: ID.ceiling }, false);
  await setRetracted('s-loadtest', false);
  check('restoring the belief clears the cascade', await taintedIds(), []);

  console.log('\nprovenance paths');
  const why = await q('verify.why', Q.WHY_PATHS, { claimIds: [ID.oneOncall] });
  const reachedLoadTest = why.some((w) => w.sourceId === 's-loadtest');
  checkTrue('the on-call decision traces back to the load test report', reachedLoadTest);
  const maxHops = Math.max(...why.map((w) => w.hops ?? 0));
  check('deepest provenance chain is three hops', maxHops, 3);

  console.log('\nanswer staleness');
  await one('verify.question', Q.RECORD_QUESTION, {
    sessionId: 'verify', questionId: 'q-verify', text: 'Are we ready?', at: now,
  });
  await one('verify.answer', Q.RECORD_ANSWER, {
    questionId: 'q-verify', answerId: 'a-verify',
    text: 'Yes, 3 nodes are enough.', at: now, claimIds: [ID.absorb],
  });
  await recomputeTaint();
  let answers = await q('verify.answers', Q.LIST_ANSWERS);
  check('answer is fresh while its claim stands', answers[0].stale, false);

  // The ceiling claim now has two sources, so withdrawing the belief is what
  // removes it - exactly the case source-level retraction cannot reach.
  const r2 = await setRetracted({ claimId: ID.ceiling }, true, 'invalid test conditions');
  answers = await q('verify.answers', Q.LIST_ANSWERS);
  check('answer goes stale when its foundation collapses', answers[0].stale, true);
  check('staleness is reported to the caller', r2.after.staleAnswers, 1);
  checkTrue('stale reason is populated', Boolean(answers[0].staleReason), answers[0].staleReason);

  console.log('\ngraph algorithm (PageRank over DERIVED_FROM)');
  await setRetracted({ claimId: ID.ceiling }, false);
  const lb = await loadBearing();
  checkTrue('pageRank returns scored claims', lb.length > 0, `got ${lb.length}`);
  if (lb.length) {
    checkTrue(
      'the most load-bearing claim is the one everything rests on',
      lb[0].id === ID.ceiling,
      `top was "${lb[0].text}"`,
    );
  }

  console.log('\nsnapshot queries used by the UI');
  for (const [name, cypher] of [
    ['sources', Q.SNAP_SOURCES], ['claims', Q.SNAP_CLAIMS], ['entities', Q.SNAP_ENTITIES],
    ['answers', Q.SNAP_ANSWERS], ['edges.states', Q.SNAP_EDGES_STATES],
    ['edges.derived', Q.SNAP_EDGES_DERIVED], ['edges.about', Q.SNAP_EDGES_ABOUT],
    ['edges.contradicts', Q.SNAP_EDGES_CONTRADICTS], ['edges.basedOn', Q.SNAP_EDGES_BASED_ON],
    ['contradictions', Q.LIST_CONTRADICTIONS], ['searchClaims-ft', Q.SEARCH_CLAIMS],
    ['entitiesByToken', Q.MATCH_ENTITIES_BY_TOKEN],
  ]) {
    try {
      await q(`verify.${name}`, cypher, { text: '(checkout)', tokens: ['checkout'], keys: [] });
      pass += 1;
      console.log(`  PASS  ${name} runs`);
    } catch (err) {
      fail += 1;
      console.log(`  FAIL  ${name} -> ${String(err?.message || err)}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
} catch (err) {
  console.error('\nverification aborted:', err);
  fail += 1;
} finally {
  await close();
  process.exit(fail > 0 ? 1 : 0);
}
