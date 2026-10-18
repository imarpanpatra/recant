'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  sources: [],
  stats: null,
  answer: null,
  cascade: null,
  blast: null,
  selected: null,
  selectedClaim: null,
  tab: 'ask',
  demo: null,
  busy: false,
};

const PRESETS = [
  'Are we ready for Black Friday on the current Checkout API setup?',
  'How many nodes does Checkout API run on?',
  'Why did we decide not to scale up?',
  'What did the September load test measure?',
  'Who is on call for Black Friday weekend?',
];

// ---------------------------------------------------------------- api

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---------------------------------------------------------------- header

function renderStats() {
  const s = state.stats;
  if (!s) return;
  const pills = [
    `<span class="pill"><b>${s.sources}</b> sources</span>`,
    `<span class="pill"><b>${s.claims}</b> claims</span>`,
    `<span class="pill"><b>${s.entities}</b> entities</span>`,
    `<span class="pill"><b>${s.answers}</b> answers</span>`,
  ];
  if (s.retractedSources > 0) {
    pills.push(`<span class="pill bad"><b>${s.retractedSources}</b> retracted</span>`);
  }
  if (s.tainted > 0) {
    pills.push(`<span class="pill bad"><b>${s.tainted}</b> claims collapsed</span>`);
  }
  if (s.staleAnswers > 0) {
    pills.push(`<span class="pill bad"><b>${s.staleAnswers}</b> stale answers</span>`);
  }
  $('stats').innerHTML = pills.join('');
}

// ---------------------------------------------------------------- sources

function renderSources() {
  const el = $('sources');
  if (!state.sources.length) {
    el.innerHTML = `<div class="empty">Memory is empty. Press <b>Reseed September</b> to ingest
      the first seven documents of the Northwind corpus.</div>`;
    return;
  }
  // The corpus is a timeline, so the UI makes the missing half explicit.
  const banner =
    state.demo && !state.demo.octoberDelivered
      ? `<div class="card" style="padding:11px">
           <h4 class="sec">Memory is at September</h4>
           <div style="font-size:12px;color:var(--muted);line-height:1.5">
             The agent only knows what the team knew before the flash sale.
             Deliver October's documents and watch what the graph does with them.
           </div>
           <button class="btn sm" id="deliver"
                   style="margin-top:9px;width:100%;white-space:normal;line-height:1.35">
             Deliver October - incident + postmortem
           </button>
         </div>`
      : '';

  el.innerHTML = banner + state.sources
    .map(
      (s) => `
      <div class="src ${s.retracted ? 'retracted' : ''} ${
        state.selected === s.id ? 'sel' : ''
      }" data-id="${esc(s.id)}">
        <div class="src-title">${esc(s.title)}</div>
        <div class="src-meta">
          <span class="kind">${esc(s.kind)}</span>
          <span>${s.claims} claim${s.claims === 1 ? '' : 's'}</span>
          ${s.retracted ? '<span class="flag-retracted">retracted</span>' : ''}
        </div>
      </div>`,
    )
    .join('');

  el.querySelectorAll('.src').forEach((node) => {
    node.onclick = () => selectSource(node.dataset.id);
  });
  const deliver = $('deliver');
  if (deliver) deliver.onclick = () => doSeed(2);
}

async function selectSource(id) {
  state.selected = id;
  state.selectedClaim = null;
  state.tab = 'source';
  renderSources();
  $('panel').innerHTML = '<div class="empty"><span class="spin"></span>Tracing blast radius&hellip;</div>';
  try {
    state.blast = await api(`/api/blast/${encodeURIComponent(id)}`);
  } catch (err) {
    state.blast = { error: String(err.message) };
  }
  renderPanel();
}

/** A single belief can be withdrawn on its own, wherever it was asserted from. */
async function selectClaim(claimId) {
  state.selectedClaim = claimId;
  state.selected = null;
  state.tab = 'source';
  renderSources();
  $('panel').innerHTML = '<div class="empty"><span class="spin"></span>Tracing blast radius&hellip;</div>';
  try {
    state.blast = await api(`/api/blast-claim/${encodeURIComponent(claimId)}`);
  } catch (err) {
    state.blast = { error: String(err.message) };
  }
  renderPanel();
}

// ---------------------------------------------------------------- graph

let cy = null;

const LAYOUT = {
  name: 'cose',
  animate: false,
  nodeRepulsion: 42000,
  idealEdgeLength: 90,
  nodeOverlap: 28,
  componentSpacing: 120,
  padding: 30,
  nestingFactor: 1.1,
  gravity: 0.6,
};

const CY_STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': '#8b93a7',
      // Claim labels are hidden by default: with ~30 claims the text collides
      // into an unreadable mass. Documents and entities stay labelled as
      // landmarks, and a claim shows its text when it matters - when it is
      // part of an answer, when it collapses, or on hover.
      label: '',
      color: '#8b93a7',
      'font-size': 8,
      'text-valign': 'center',
      'text-halign': 'right',
      'text-margin-x': 5,
      'text-max-width': 110,
      'text-wrap': 'ellipsis',
      width: 11,
      height: 11,
      'border-width': 0,
    },
  },
  {
    selector: 'node[type="Source"]',
    style: {
      'background-color': '#8b93a7', shape: 'round-rectangle', width: 15, height: 11,
      label: 'data(short)', 'font-size': 8.5, color: '#9aa3b8',
    },
  },
  { selector: 'node[type="Claim"]', style: { 'background-color': '#5eead4', width: 12, height: 12 } },
  {
    selector: 'node[type="Entity"]',
    style: {
      'background-color': '#a78bfa', shape: 'diamond', width: 10, height: 10,
      label: 'data(short)', 'font-size': 8.5, color: '#a78bfa',
    },
  },
  {
    selector: 'node[type="Answer"]',
    style: {
      'background-color': '#60a5fa', shape: 'hexagon', width: 14, height: 14,
      label: 'data(short)', 'font-size': 8.5, color: '#60a5fa',
    },
  },
  {
    selector: 'node[?dead]',
    style: {
      'background-color': '#f87171',
      color: '#f87171',
      label: 'data(short)',
      'font-size': 9,
      'z-index': 10,
      'border-width': 2,
      'border-color': '#7f1d1d',
      'border-style': 'dashed',
    },
  },
  {
    selector: 'node[?used]',
    style: {
      'border-width': 3,
      'border-color': '#5eead4',
      color: '#e7ebf3',
      label: 'data(short)',
      'font-size': 9,
      'z-index': 11,
    },
  },
  {
    selector: 'node.hl',
    style: { label: 'data(short)', color: '#e7ebf3', 'font-size': 10, 'z-index': 20 },
  },
  {
    selector: 'edge',
    style: {
      width: 1,
      'line-color': '#242a37',
      'target-arrow-color': '#242a37',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.55,
      'curve-style': 'bezier',
    },
  },
  { selector: 'edge[type="DERIVED_FROM"]', style: { 'line-color': '#3c4761', 'target-arrow-color': '#3c4761', width: 1.6 } },
  { selector: 'edge[type="ABOUT"]', style: { 'line-color': '#2a2440', 'target-arrow-color': '#2a2440', 'line-style': 'dotted' } },
  { selector: 'edge[type="CONTRADICTS"]', style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171', 'line-style': 'dashed', width: 1.6 } },
  { selector: 'edge[type="BASED_ON"]', style: { 'line-color': '#1e3a5f', 'target-arrow-color': '#1e3a5f' } },
  { selector: 'edge[?dead]', style: { 'line-color': '#5b2626', 'target-arrow-color': '#5b2626' } },
];

async function renderGraph() {
  const g = await api('/api/graph');
  const used = new Set(state.answer?.used ?? []);
  const dead = new Set(
    g.nodes.filter((n) => n.tainted || n.retracted || n.stale).map((n) => n.id),
  );

  const elements = [
    ...g.nodes.map((n) => ({
      data: {
        id: n.id,
        type: n.type,
        short: clip(n.label, n.type === 'Entity' ? 22 : 34),
        full: n.label,
        dead: dead.has(n.id) || undefined,
        used: used.has(n.id) || undefined,
        detail: n.taintReason || n.taintedBy || '',
      },
    })),
    ...g.edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        type: e.type,
        dead: dead.has(e.source) || dead.has(e.target) || undefined,
      },
    })),
  ];

  $('graph-note').innerHTML =
    `<span style="color:var(--dim)">${g.nodes.length} nodes &middot; ${g.edges.length} edges</span>`;

  if (!cy) {
    cy = cytoscape({
      container: $('graph'),
      elements,
      style: CY_STYLE,
      layout: LAYOUT,
      wheelSensitivity: 0.25,
      minZoom: 0.2,
      maxZoom: 3,
    });
    cy.on('tap', 'node', (evt) => {
      const d = evt.target.data();
      toast(`${d.type}: ${d.full}${d.detail ? ` - ${d.detail}` : ''}`);
      if (d.type === 'Claim') selectClaim(d.id);
    });
    // Hover reveals the label of a claim that is otherwise unlabelled.
    cy.on('mouseover', 'node', (e) => {
      e.target.addClass('hl');
      e.target.neighborhood('node').addClass('hl');
      $('graph').style.cursor = 'pointer';
    });
    cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hl');
      e.target.neighborhood('node').removeClass('hl');
      $('graph').style.cursor = 'default';
    });
  } else {
    cy.json({ elements });
    cy.layout(LAYOUT).run();
  }
  cy.fit(undefined, 28);
}

// ---------------------------------------------------------------- panel

function verdictClass(v) {
  return v === 'yes' ? 'v-yes' : v === 'no' ? 'v-no' : 'v-unknown';
}

function whyHtml(why) {
  if (!why?.length) return '';
  return why
    .map((w) => {
      const deepest = w.chains.filter((c) => c.sourceId);
      const steps = deepest
        .map((c) => {
          const chain = (c.chainTexts || []).slice(1);
          const hops = chain.length
            ? chain.map((t) => `<div class="chain-step">${esc(clip(t, 110))}</div>`).join('')
            : '';
          return `${hops}<div class="chain-step">stated by
            <span class="chain-src ${c.sourceRetracted ? 'dead' : ''}">${esc(c.sourceTitle || 'unknown source')}</span>
            ${c.sourceRetracted ? '(retracted)' : ''}</div>`;
        })
        .join('');
      return `<div class="chain">
        <div class="chain-claim">${esc(w.claimText)}
          <button class="btn ghost sm" style="margin-left:6px;font-size:10px;padding:1px 7px"
                  data-claim="${esc(w.claimId)}">retract</button>
        </div>
        ${steps || '<div class="chain-step">no recorded source</div>'}
      </div>`;
    })
    .join('');
}

function answerHtml(a) {
  if (!a) return '';
  return `
    <div class="card flash">
      <span class="verdict ${verdictClass(a.verdict)}">${esc(a.verdict)}</span>
      <div class="answer-text">${esc(a.answer)}</div>
      ${a.caveats ? `<div class="sub"><span>⚠ ${esc(a.caveats)}</span></div>` : ''}
      <div class="sub">
        <span>confidence ${Math.round((a.confidence ?? 0) * 100)}%</span>
        <span>${a.contextSize} claims traversed</span>
        <span>${a.used.length} relied on</span>
        <span>${a.ms}ms</span>
      </div>
      ${a.seeds?.length ? `<div class="sub"><span>anchored on: ${esc(a.seeds.join(', '))}</span></div>` : ''}
      <details class="why" open>
        <summary>Why this answer - provenance walked back to source</summary>
        ${whyHtml(a.why) || '<div class="empty">No provenance: the answer relied on nothing in memory.</div>'}
      </details>
    </div>`;
}

function cascadeHtml(c) {
  if (!c?.cascade?.length) return '';
  const byHop = {};
  c.cascade.forEach((x) => {
    (byHop[x.hops] ??= []).push(x);
  });
  return `
    <div class="card alarm flash">
      <h4 class="sec">Cascade from retracting &ldquo;${esc(c.source.title)}&rdquo;</h4>
      <div class="sub" style="margin-top:0">
        <span><b>${c.after.taintedClaims}</b> claims collapsed</span>
        <span><b>${c.after.staleAnswers}</b> answers now stale</span>
        <span>${c.taint.hops} propagation hops</span>
        <span>${c.taint.ms}ms</span>
      </div>
      ${Object.keys(byHop)
        .sort((a, b) => a - b)
        .map((h) =>
          byHop[h]
            .map(
              (x) => `<div class="cascade-item">
                <span class="hop">${h === '0' ? 'direct' : `+${h} hop`}</span>
                <div>
                  <div>${esc(x.text)}</div>
                  <div class="cascade-reason">${esc(x.reason || '')}</div>
                </div>
              </div>`,
            )
            .join(''),
        )
        .join('')}
    </div>`;
}

function blastHtml(b) {
  if (!b) return '';
  if (b.error) return `<div class="card"><div class="err">${esc(b.error)}</div></div>`;
  const isClaim = Boolean(b.claimId);
  const src = state.sources.find((s) => s.id === state.selected);
  const retracted = isClaim ? b.retracted : src?.retracted;
  const label = isClaim
    ? retracted ? 'Retracted belief' : 'Blast radius of one belief'
    : retracted ? 'Retracted source' : 'Blast radius';
  return `
    <div class="card">
      <h4 class="sec">${label}</h4>
      <div class="answer-text" style="font-size:13.5px">${esc(b.title)}</div>
      <div class="sub">
        ${isClaim ? '' : `<span><b>${b.directClaims}</b> claims stated directly</span>`}
        <span><b>${b.derivedClaims}</b> downstream inferences</span>
        <span><b>${b.affectedAnswers.length}</b> past answers at risk</span>
      </div>
      ${
        isClaim && b.statedBy?.length
          ? `<div class="sub"><span>asserted by ${b.statedBy.length} source(s):
             ${esc(b.statedBy.join('; '))}</span></div>
             ${
               b.statedBy.length > 1
                 ? `<div class="cascade-reason" style="margin-top:6px">Retracting any single one
                    of those documents would leave this belief standing. Withdrawing the belief
                    itself is the only thing that removes it.</div>`
                 : ''
             }`
          : ''
      }
      ${
        b.rootTexts.length
          ? `<div class="chain" style="margin-top:12px">
              ${b.rootTexts.map((t) => `<div class="chain-claim">${esc(clip(t, 130))}</div>`).join('')}
              ${b.derivedTexts
                .slice(0, 8)
                .map((t) => `<div class="chain-step">${esc(clip(t, 120))}</div>`)
                .join('')}
             </div>`
          : '<div class="empty">This source states no extracted claims.</div>'
      }
      <div style="margin-top:13px;display:flex;gap:7px">
        ${
          retracted
            ? `<button class="btn ghost sm" id="restore">Restore this ${isClaim ? 'belief' : 'source'}</button>`
            : `<button class="btn danger sm" id="do-retract">Retract this ${isClaim ? 'belief' : 'source'}</button>`
        }
        <button class="btn ghost sm" id="back">Back to ask</button>
      </div>
    </div>`;
}

/** Any `data-claim` button anywhere in the panel opens that belief. */
function wireClaimButtons() {
  $('panel')
    .querySelectorAll('[data-claim]')
    .forEach((b) => {
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectClaim(b.dataset.claim);
      };
    });
}

async function renderPanel() {
  await renderPanelInner();
  wireClaimButtons();
}

async function renderPanelInner() {
  const el = $('panel');

  if (state.tab === 'source') {
    el.innerHTML = blastHtml(state.blast) + cascadeHtml(state.cascade);
    const r = $('do-retract');
    if (r) r.onclick = () => doRetract(true);
    const rs = $('restore');
    if (rs) rs.onclick = () => doRetract(false);
    const b = $('back');
    if (b) b.onclick = () => { state.tab = 'ask'; state.selected = null; renderSources(); renderPanel(); };
    return;
  }

  if (state.tab === 'memory') {
    el.innerHTML = '<div class="empty"><span class="spin"></span>Loading memory&hellip;</div>';
    const answers = await api('/api/answers');
    const contradictions = await api('/api/contradictions');
    el.innerHTML = `
      <div class="card">
        <h4 class="sec">Recorded answers</h4>
        ${
          answers.length
            ? answers
                .map(
                  (a) => `<div class="row">
                    <div>
                      <div class="${a.stale ? 'struck' : ''}">${esc(clip(a.text, 150))}</div>
                      <div class="cascade-reason">asked: ${esc(clip(a.question, 90))}</div>
                      ${a.stale ? `<div class="cascade-reason" style="color:#fca5a5">${esc(a.staleReason || '')}</div>` : ''}
                    </div>
                    <div>${a.stale ? '<span class="stale-badge">stale</span>' : `<span class="num">${a.claimCount}</span>`}</div>
                  </div>`,
                )
                .join('')
            : '<div class="empty">No answers recorded yet.</div>'
        }
      </div>
      <div class="card">
        <h4 class="sec">Contradictions the graph is holding</h4>
        ${
          contradictions.length
            ? contradictions
                .map(
                  (c) => `<div class="row"><div>
                    <div class="${c.aTainted ? 'struck' : ''}">${esc(clip(c.aText, 120))}</div>
                    <div class="chain-step" style="padding-left:0;color:var(--bad)">conflicts with</div>
                    <div class="${c.bTainted ? 'struck' : ''}">${esc(clip(c.bText, 120))}</div>
                    ${c.note ? `<div class="cascade-reason">${esc(c.note)}</div>` : ''}
                  </div></div>`,
                )
                .join('')
            : '<div class="empty">None detected.</div>'
        }
      </div>`;
    return;
  }

  if (state.tab === 'risk') {
    el.innerHTML = '<div class="empty"><span class="spin"></span>Running PageRank&hellip;</div>';
    const lb = await api('/api/load-bearing');
    el.innerHTML = `
      <div class="card">
        <h4 class="sec">Load-bearing beliefs - PageRank over DERIVED_FROM</h4>
        <div class="cascade-reason" style="margin-bottom:8px">
          The claims the most reasoning rests on. If one of these is wrong, the damage is widest.
        </div>
        ${
          lb.length
            ? lb
                .map(
                  (c) => `<div class="row">
                    <div>
                      <div>${esc(clip(c.text, 130))}</div>
                      <div class="cascade-reason">${c.dependents} dependent claim(s)${
                        c.sources?.length ? ` &middot; ${esc(c.sources.join('; '))}` : ''
                      }</div>
                    </div>
                    <div style="display:flex;gap:7px;align-items:flex-start;flex-shrink:0">
                      <span class="num">${Number(c.score).toFixed(3)}</span>
                      <button class="btn ghost sm" data-claim="${esc(c.id)}">retract</button>
                    </div>
                  </div>`,
                )
                .join('')
            : '<div class="empty">No derivation edges yet - seed the memory first.</div>'
        }
      </div>`;
    return;
  }

  el.innerHTML =
    (state.answer ? answerHtml(state.answer) : '<div class="empty">Ask the memory a question.</div>') +
    cascadeHtml(state.cascade);
}

// ---------------------------------------------------------------- actions

async function refresh({ graph = true } = {}) {
  const [stats, sources] = await Promise.all([api('/api/stats'), api('/api/sources')]);
  state.stats = stats;
  state.sources = sources;
  renderStats();
  renderSources();
  if (graph) await renderGraph().catch((e) => console.warn('graph', e));
}

async function doAsk() {
  const question = $('question').value.trim();
  if (!question || state.busy) return;
  state.busy = true;
  $('ask').disabled = true;
  state.tab = 'ask';
  state.cascade = null;
  state.selected = null;
  state.selectedClaim = null;
  $('panel').innerHTML = '<div class="empty"><span class="spin"></span>Traversing memory&hellip;</div>';
  try {
    state.answer = await api('/api/ask', { method: 'POST', body: { question } });
    await renderPanel();
    await refresh();
  } catch (err) {
    $('panel').innerHTML = `<div class="card"><div class="err">${esc(err.message)}</div></div>`;
  } finally {
    state.busy = false;
    $('ask').disabled = false;
  }
}

async function doRetract(retracted) {
  const claimId = state.selectedClaim;
  const sourceId = state.selected;
  if ((!claimId && !sourceId) || state.busy) return;
  state.busy = true;
  // The reason is stored on the node and shown as the cascade's "direct" line,
  // so it is worth being specific. Once October has landed, a withdrawn belief
  // is being withdrawn because of the postmortem.
  const reason = !retracted
    ? ''
    : claimId && state.demo?.octoberDelivered
      ? state.demo.reason
      : 'retracted by operator';
  $('panel').innerHTML = `<div class="empty"><span class="spin"></span>${
    retracted ? 'Propagating retraction through the graph' : 'Restoring'
  }&hellip;</div>`;
  try {
    const result = await api('/api/retract', {
      method: 'POST',
      body: claimId ? { claimId, retracted, reason } : { sourceId, retracted, reason },
    });
    state.cascade = retracted ? result : null;
    await refresh();
    state.blast = claimId
      ? await api(`/api/blast-claim/${encodeURIComponent(claimId)}`)
      : await api(`/api/blast/${encodeURIComponent(sourceId)}`);
    await renderPanel();
    toast(
      retracted
        ? `${result.after.taintedClaims} claims collapsed, ${result.after.staleAnswers} answers stale`
        : 'Source restored, memory recomputed',
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
  }
}

async function doSeed(phaseArg = 1) {
  // Guard against being wired straight to an onclick handler, which would
  // pass a MouseEvent here. That used to make "Reseed September" send
  // wipe:false, so it quietly re-ingested on top of the existing graph
  // instead of resetting it.
  const phase = Number(phaseArg) === 2 ? 2 : 1;
  if (state.busy) return;
  state.busy = true;
  $('seed').disabled = true;
  try {
    const started = await api('/api/seed', { method: 'POST', body: { phase, wipe: phase === 1 } });
    const total = started.total;
    $('sources').innerHTML = `<div class="empty"><span class="spin"></span>Ingesting 0/${total}&hellip;</div>`;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      const job = await api('/api/seed/status');
      $('sources').innerHTML = `<div class="empty"><span class="spin"></span>Ingesting ${job.done}/${
        job.total
      }&hellip;<br><span style="font-size:11px">${esc(job.log.at(-1)?.title || '')}</span></div>`;
      if (!job.running) {
        if (job.error) toast(job.error, true);
        break;
      }
    }
    state.demo = await api('/api/demo');
    await refresh();
    toast(phase === 2 ? 'October documents delivered into memory' : 'September memory seeded');
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    $('seed').disabled = false;
  }
}

// ---------------------------------------------------------------- boot

function wire() {
  $('ask').onclick = doAsk;
  $('question').onkeydown = (e) => { if (e.key === 'Enter') doAsk(); };
  $('seed').onclick = () => doSeed(1);

  $('chips').innerHTML = PRESETS.map(
    (p, i) => `<button class="chip" data-i="${i}">${esc(clip(p, 42))}</button>`,
  ).join('');
  $('chips').querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      $('question').value = PRESETS[Number(c.dataset.i)];
      doAsk();
    };
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      state.tab = t.dataset.tab;
      state.selected = null;
      state.selectedClaim = null;
      renderSources();
      renderPanel();
    };
  });
}

(async function boot() {
  wire();
  try {
    const h = await api('/api/health');
    if (!h.ok) toast('FalkorDB not reachable: ' + (h.db?.error || 'unknown'), true);
    if (!h.llm.configured) toast('No GEMINI_API_KEY set - running in graph-only fallback mode', true);
    state.demo = await api('/api/demo');
  } catch (err) {
    toast('Server not ready: ' + err.message, true);
  }
  await refresh().catch((e) => toast(e.message, true));
  await renderPanel();
})();
