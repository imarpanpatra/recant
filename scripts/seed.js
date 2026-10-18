import 'dotenv/config';
import { one, close } from '../src/db.js';
import { WIPE } from '../src/queries.js';
import { ingestAll } from '../src/ingest.js';
import { CORPUS, PHASE1, PHASE2 } from '../data/corpus.js';

// The corpus is a timeline. By default only the September documents are
// ingested, which is the state the agent is in before the flash sale - it
// still believes the load test. `--all` loads the October documents too.
const all = process.argv.includes('--all');
const phase2Only = process.argv.includes('--phase2');
const keep = process.argv.includes('--keep') || phase2Only;

const docs = phase2Only ? PHASE2 : all ? CORPUS : PHASE1;

try {
  if (!keep) {
    await one('seed.wipe', WIPE);
    console.log('graph wiped');
  }
  const results = await ingestAll(docs);
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  console.log(
    `\nseeded ${results.length} documents -> ${sum('claims')} claims, ` +
      `${sum('derivations')} derivations, ${sum('contradictions')} contradictions`,
  );
  if (!all && !phase2Only) {
    console.log('(September only. Run `npm run seed:october` to deliver the postmortem.)');
  }
} finally {
  await close();
}
