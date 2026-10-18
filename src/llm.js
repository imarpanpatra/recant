/**
 * Gemini wrapper. Everything the model does here is structured extraction or
 * synthesis over a subgraph that FalkorDB has already selected - the model
 * never searches, and it is never given a claim the graph marked tainted.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google retires older model ids for new API keys, so the client probes a
// short list and remembers whichever one this key can actually call.
//
// The free-tier rate limit is GenerateRequestsPerMinutePerProjectPerModel -
// a separate bucket per model. So when one model is throttled the next
// candidate usually still has room, and only an all-throttled chain has to
// wait. Ingesting a corpus is bursty, and this is what keeps it moving.
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
].filter(Boolean);

const RETRYABLE = new Set([429, 500, 503]);
const MAX_ROUNDS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Google returns a suggested wait as `"retryDelay": "3s"` inside the error. */
function suggestedDelay(message) {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message || '');
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

let workingModel = null;

export function llmAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function callModel(model, { system, prompt, json, temperature = 0.2 }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 2048,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`gemini ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || '').join('').trim();
}

/**
 * Calls Gemini, discovering which model this API key can actually use and
 * riding out per-minute throttling by moving across models before waiting.
 */
export async function gen(opts) {
  if (!llmAvailable()) throw new Error('GEMINI_API_KEY not set');

  let lastErr = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // Prefer the model that worked last time, then everything else.
    const models = workingModel
      ? [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)]
      : MODEL_CANDIDATES;

    let throttled = false;
    for (const model of models) {
      try {
        const out = await callModel(model, opts);
        workingModel = model;
        return out;
      } catch (err) {
        lastErr = err;
        if (RETRYABLE.has(err.status)) {
          throttled = true;
          if (workingModel === model) workingModel = null;
          continue; // another model has its own quota bucket
        }
        // 404 = retired or unavailable for this key; 400 = rejected request.
        if (err.status === 404 || err.status === 400) continue;
        throw err;
      }
    }

    if (!throttled) break;
    const wait = suggestedDelay(lastErr?.message) ?? 2000 * 2 ** round;
    console.warn(`[llm] all models throttled, waiting ${wait}ms (round ${round + 1})`);
    await sleep(wait);
  }

  throw lastErr ?? new Error('no usable Gemini model');
}

export async function genJSON(opts) {
  const raw = await gen({ ...opts, json: true });
  return parseJSON(raw);
}

export function parseJSON(raw) {
  if (!raw) return null;
  let text = raw.trim();
  // Strip code fences the model sometimes adds despite responseMimeType.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    return null;
  }
}

export function modelInUse() {
  return workingModel || MODEL_CANDIDATES[0] || null;
}
