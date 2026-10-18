import { q, one } from './db.js';
import * as Q from './queries.js';

const MAX_ITERATIONS = 12;

/**
 * Recompute which beliefs still stand.
 *
 * Deliberately a fixpoint over single-hop edges rather than one big
 * variable-length write: it terminates on cyclic reasoning, it gives every
 * claim an honest hop-distance from the retraction, and each iteration is a
 * query you can run by hand in the FalkorDB browser to watch the wave move.
 */
export async function recomputeTaint() {
  const started = Date.now();
  await one('taint.clear', Q.CLEAR_TAINT);

  // Two kinds of root: a claim withdrawn directly, and a claim whose every
  // stating source has been retracted.
  const direct = await one('taint.retractedClaims', Q.TAINT_RETRACTED_CLAIMS);
  const roots = await one('taint.unsupportedRoots', Q.TAINT_UNSUPPORTED_ROOTS);
  const rootCount = (direct?.n ?? 0) + (roots?.n ?? 0);

  const waves = [];
  let total = rootCount;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const row = await one('taint.propagate', Q.PROPAGATE_TAINT_ONE_HOP);
    const n = row?.n ?? 0;
    if (n === 0) break;
    waves.push(n);
    total += n;
  }

  await one('answers.resetStale', Q.RESET_ANSWER_STALENESS);
  const stale = await one('answers.markStale', Q.MARK_STALE_ANSWERS);

  const report = {
    directlyUnsupported: rootCount,
    propagationWaves: waves,
    taintedClaims: total,
    staleAnswers: stale?.n ?? 0,
    hops: waves.length,
    ms: Date.now() - started,
  };
  console.log('[taint]', JSON.stringify(report));
  return report;
}

/** Read-only: what would break if this source were retracted. */
export async function blastRadius(sourceId) {
  const row = await one('retract.blastRadius', Q.BLAST_RADIUS, { sourceId });
  if (!row) return null;
  return {
    sourceId,
    title: row.title,
    directClaims: row.directClaims ?? 0,
    derivedClaims: row.derivedClaims ?? 0,
    totalClaims: (row.directClaims ?? 0) + (row.derivedClaims ?? 0),
    affectedAnswers: row.affectedAnswers ?? [],
    rootTexts: row.rootTexts ?? [],
    derivedTexts: row.derivedTexts ?? [],
  };
}

/** Blast radius for a single claim, wherever it was asserted from. */
export async function claimBlastRadius(claimId) {
  const row = await one('retract.claimBlastRadius', Q.CLAIM_BLAST_RADIUS, { claimId });
  if (!row) return null;
  return {
    claimId,
    title: row.title,
    retracted: row.retracted ?? false,
    tainted: row.tainted ?? false,
    directClaims: 1,
    derivedClaims: row.derivedClaims ?? 0,
    totalClaims: 1 + (row.derivedClaims ?? 0),
    statedBy: row.statedBy ?? [],
    affectedAnswers: row.affectedAnswers ?? [],
    rootTexts: row.rootTexts ?? [],
    derivedTexts: row.derivedTexts ?? [],
  };
}

/**
 * Retract either a source or a single claim. Both funnel through the same
 * recomputation, so the two kinds of withdrawal compose: retract a document
 * and a claim it shares with another document, and the cascade accounts for
 * both at once.
 */
export async function setRetracted(target, retracted, reason = '') {
  const isClaim = typeof target === 'object' ? Boolean(target.claimId) : false;
  const sourceId = typeof target === 'object' ? target.sourceId : target;
  const claimId = typeof target === 'object' ? target.claimId : null;

  const before = await one('retract.statsBefore', Q.STATS);

  const source = isClaim
    ? await one('retract.setClaimFlag', Q.SET_CLAIM_RETRACTED, {
        claimId,
        retracted: Boolean(retracted),
        reason: String(reason || '').slice(0, 300),
        at: new Date().toISOString(),
      })
    : await one('retract.setFlag', Q.SET_SOURCE_RETRACTED, {
        sourceId,
        retracted: Boolean(retracted),
        reason: String(reason || '').slice(0, 300),
        at: new Date().toISOString(),
      });

  if (!source) {
    throw Object.assign(new Error(`unknown ${isClaim ? 'claim' : 'source'}: ${claimId || sourceId}`), {
      status: 404,
    });
  }

  const taint = await recomputeTaint();
  const after = await one('retract.statsAfter', Q.STATS);
  const tainted = await q('retract.taintReport', Q.TAINT_REPORT);

  return {
    source,
    target: isClaim ? 'claim' : 'source',
    retracted: Boolean(retracted),
    reason,
    taint,
    before: { taintedClaims: before?.tainted ?? 0, staleAnswers: before?.staleAnswers ?? 0 },
    after: { taintedClaims: after?.tainted ?? 0, staleAnswers: after?.staleAnswers ?? 0 },
    cascade: tainted.map((t) => ({
      id: t.id,
      text: t.text,
      hops: t.depth ?? 0,
      reason: t.reason,
      entities: t.entities ?? [],
    })),
  };
}

export async function loadBearing() {
  try {
    const rows = await q('algo.pageRank', Q.LOAD_BEARING_CLAIMS);
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      score: r.score,
      dependents: r.dependents ?? 0,
      sources: r.sources ?? [],
    }));
  } catch (err) {
    console.warn('[algo] pageRank unavailable:', String(err?.message || err));
    return [];
  }
}
