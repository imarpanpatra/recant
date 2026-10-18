import { FalkorDB } from 'falkordb';
import { SCHEMA_STATEMENTS } from './queries.js';

let db = null;
let ready = null;

/**
 * Build connection options for either FalkorDB Cloud or a local instance.
 *
 * FalkorDB Cloud hands you a connection string that looks like
 *   falkordb://<user>:<pass>@<host>:<port>
 * TLS-enabled instances use `falkors://`. We normalise both into the
 * socket options that falkordb-ts forwards to node-redis.
 */
function connectionOptions() {
  const raw = (process.env.FALKORDB_URL || '').trim();

  if (raw) {
    const url = new URL(raw);
    const tls = url.protocol === 'falkors:' || url.protocol === 'rediss:' ||
      String(process.env.FALKORDB_TLS || '').toLowerCase() === 'true';
    return {
      socket: {
        host: url.hostname,
        port: Number(url.port || 6379),
        tls,
        connectTimeout: 15000,
      },
      username: decodeURIComponent(url.username || '') || undefined,
      password: decodeURIComponent(url.password || '') || undefined,
    };
  }

  return {
    socket: {
      host: process.env.FALKORDB_HOST || 'localhost',
      port: Number(process.env.FALKORDB_PORT || 6379),
      tls: String(process.env.FALKORDB_TLS || '').toLowerCase() === 'true',
      connectTimeout: 15000,
    },
    username: process.env.FALKORDB_USERNAME || undefined,
    password: process.env.FALKORDB_PASSWORD || undefined,
  };
}

export const GRAPH_NAME = process.env.FALKORDB_GRAPH || 'recant';

async function connect() {
  db = await FalkorDB.connect(connectionOptions());
  const graph = db.selectGraph(GRAPH_NAME);

  // Indexes are created once, up front. FalkorDB rejects duplicates, so each
  // statement is attempted independently and "already indexed" is not an error.
  for (const stmt of SCHEMA_STATEMENTS) {
    try {
      await graph.query(stmt);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/already (indexed|exists)|Attribute .* is already indexed/i.test(msg)) {
        console.warn('[schema] skipped:', stmt.split('\n')[0], '->', msg);
      }
    }
  }
  return graph;
}

export function graph() {
  if (!ready) ready = connect();
  return ready;
}

/**
 * Run a Cypher query. Every call is logged with its label so the server log
 * doubles as a trace of which graph operations backed which HTTP request.
 */
export async function q(label, cypher, params = {}) {
  const g = await graph();
  const started = Date.now();
  const res = await g.query(cypher, { params });
  const rows = res?.data ?? [];
  console.log(`[cypher] ${label} (${rows.length} rows, ${Date.now() - started}ms)`);
  return rows;
}

export async function one(label, cypher, params = {}) {
  const rows = await q(label, cypher, params);
  return rows[0] ?? null;
}

export async function health() {
  try {
    const rows = await q('health', 'RETURN 1 AS ok');
    return { ok: rows?.[0]?.ok === 1, graph: GRAPH_NAME };
  } catch (err) {
    return { ok: false, graph: GRAPH_NAME, error: String(err?.message || err) };
  }
}

export async function close() {
  if (db) await db.close();
  db = null;
  ready = null;
}
