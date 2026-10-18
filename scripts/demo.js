/**
 * The demo, as a script - the whole story end to end, printing what the agent
 * believed, what arrived, what collapsed, and what it believes afterwards.
 *
 *   npm run demo
 *
 * It reseeds from scratch so it is repeatable.
 */
import 'dotenv/config';
import { q, one, close } from '../src/db.js';
import * as Q from '../src/queries.js';
import { ask } from '../src/agent.js';
import { ingestAll } from '../src/ingest.js';
import { setRetracted, claimBlastRadius, loadBearing } from '../src/retract.js';
import { PHASE1, PHASE2 } from '../data/corpus.js';

const QUESTION = 'Are we ready for Black Friday on the current Checkout API setup?';
const rule = (n, t) =>
  console.log(`\n${'='.repeat(74)}\n  BEAT ${n}  ${t}\n${'='.repeat(74)}`);
const wrap = (t) => String(t).replace(/(.{1,86})(\s|$)/g, '    $1\n').trimEnd();

function showAnswer(a) {
  console.log(`    Q: ${QUESTION}\n`);
  console.log(`    VERDICT: ${a.verdict.toUpperCase()}   confidence ${a.confidence}\n`);
  console.log(wrap(a.answer));
  console.log(`\n    traversed ${a.contextSize} valid claims, relied on ${a.used.length}`);
  if (a.why.length) {
    console.log('\n    why:');
    for (const w of a.why.slice(0, 3)) {
      console.log(`      - ${w.claimText}`);
      for (const c of w.chains.filter((x) => x.sourceTitle).slice(0, 2)) {
        console.log(`          stated by: ${c.sourceTitle}${c.hops ? `  (${c.hops} hops back)` : ''}`);
      }
    }
  }
}

try {
  rule(0, 'September: ingest what the team knew before the flash sale');
  await one('demo.wipe', Q.WIPE);
  const r1 = await ingestAll(PHASE1);
  console.log(
    `    ${r1.length} documents -> ${r1.reduce((n, r) => n + r.claims, 0)} claims, ` +
      `${r1.reduce((n, r) => n + r.derivations, 0)} derivation edges`,
  );

  rule(1, 'Ask the memory');
  const before = await ask(QUESTION);
  showAnswer(before);

  rule(2, 'Which belief is everything resting on?  (PageRank over DERIVED_FROM)');
  const lb = await loadBearing();
  lb.slice(0, 5).forEach((c, i) =>
    console.log(`    ${i + 1}. score ${c.score.toFixed(3)}  ${c.dependents} dependents  ${c.text}`),
  );
  const target =
    lb.find((c) => /1,?200/.test(c.text) && /sustain|ceiling|rps|requests/i.test(c.text)) ?? lb[0];
  console.log(`\n    -> picking: ${target.text}`);

  rule(3, 'October arrives: the incident, then the postmortem');
  const r2 = await ingestAll(PHASE2);
  r2.forEach((r) =>
    console.log(`    + ${r.title}\n        ${r.claims} claims, ${r.contradictions} contradiction(s) detected`),
  );
  const contradictions = await q('demo.contradictions', Q.LIST_CONTRADICTIONS);
  if (contradictions.length) {
    console.log('\n    the graph is now holding a conflict:');
    contradictions.forEach((c) => {
      console.log(`      "${c.aText}"`);
      console.log(`         conflicts with "${c.bText}"`);
      if (c.note) console.log(`         ${c.note}`);
    });
  }

  rule(4, 'The operator withdraws the invalidated belief');
  const blast = await claimBlastRadius(target.id);
  console.log(`    belief:  ${blast.title}`);
  console.log(`    asserted by ${blast.statedBy.length} source(s): ${blast.statedBy.join('; ')}`);
  console.log(`    downstream inferences at risk: ${blast.derivedClaims}`);
  console.log(`    past answers at risk: ${blast.affectedAnswers.length}`);

  const result = await setRetracted(
    { claimId: target.id },
    true,
    'Postmortem INC-4412: measured on a 10x-smaller, cache-warmed dataset; does not transfer to production',
  );
  console.log(`\n    claims collapsed:  ${result.after.taintedClaims}`);
  console.log(`    answers now stale: ${result.after.staleAnswers}`);
  console.log(
    `    propagation: ${result.taint.propagationWaves.join(' -> ')} across ` +
      `${result.taint.hops} hops in ${result.taint.ms}ms\n`,
  );
  for (const c of result.cascade) {
    console.log(`      [${c.hops === 0 ? 'direct' : `+${c.hops} hop`}] ${c.text}`);
  }

  rule(5, 'Ask the same question again');
  const after = await ask(QUESTION);
  showAnswer(after);

  const answers = await q('demo.answers', Q.LIST_ANSWERS);
  console.log('\n    recorded answers in memory:');
  answers.forEach((a) =>
    console.log(`      ${a.stale ? '[STALE]' : '[valid]'} ${String(a.text).slice(0, 72)}...`),
  );

  console.log(`\n${'='.repeat(74)}`);
  console.log(`  ${before.verdict.toUpperCase()}  ->  ${after.verdict.toUpperCase()}`);
  console.log(`  ${before.contextSize} valid claims  ->  ${after.contextSize} valid claims`);
  console.log(`${'='.repeat(74)}\n`);
} finally {
  await close();
}
