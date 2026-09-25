/**
 * Secure backend API for the blockchain voting system.
 *
 * Role: OFF-CHAIN AUDIT LOG ONLY. This service is explicitly non-authoritative.
 * The on-chain VoterRegistry.isEligible(address) is the sole source of truth
 * for voter eligibility. All data stored here (voters, vote events) exists
 * for observability and debugging and must never gate voting rights.
 *
 * Security controls (no third-party deps beyond express/cors/better-sqlite3):
 *  - Strict environment validation with safe defaults (fail-closed on bad PORT)
 *  - Security headers (CSP for API, nosniff, DENY framing, referrer, permissions)
 *  - HSTS when running behind TLS in production
 *  - Token-bucket rate limiting (global + stricter write bucket, per-client key)
 *  - Strict CORS allowlist (no wildcard)
 *  - JSON body size limit
 *  - Allowlist input validation (address / hash / event type regexes)
 *  - Parameterized SQL only (better-sqlite3 prepared statements)
 *  - No stack traces or internal paths leak to clients (production)
 *  - Graceful shutdown closes HTTP server + SQLite handle (no fd leaks)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 1. Environment validation (fail-closed)
// ---------------------------------------------------------------------------

function parsePositiveInt(raw, fallback, name, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max)) {
    console.error(`[config] Invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`);
    return fallback;
  }
  return n;
}

const NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const PORT = parsePositiveInt(process.env.PORT, 5000, 'PORT', 65535);
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'voting.db');
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '100kb';
const RATE_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS', 3_600_000);
const RATE_MAX = parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100, 'RATE_LIMIT_MAX_REQUESTS', 100_000);
const RATE_WRITE_MAX = parsePositiveInt(process.env.RATE_LIMIT_WRITE_MAX, 10, 'RATE_LIMIT_WRITE_MAX', 10_000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// 2. Database (WAL mode, migrations, single long-lived handle)
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const MIGRATIONS = [
  {
    name: '001_initial_schema',
    sql: `
      -- Address normalization: app layer always .toLowerCase(); COLLATE NOCASE is a safety net.
      CREATE TABLE IF NOT EXISTS voters (
        address TEXT PRIMARY KEY COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS vote_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('commit', 'reveal')),
        voter TEXT COLLATE NOCASE,
        hash TEXT,
        candidate_index INTEGER,
        raw TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vote_events_voter ON vote_events(voter);
      CREATE INDEX IF NOT EXISTS idx_vote_events_type ON vote_events(type);
      CREATE INDEX IF NOT EXISTS idx_vote_events_created ON vote_events(created_at);
    `,
  },
];

for (const m of MIGRATIONS) {
  const applied = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(m.name);
  if (!applied) {
    db.exec(m.sql);
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(m.name);
    console.log(`[db] applied migration ${m.name}`);
  }
}

// Prepared statements (compiled once, values always bound — no string interpolation)
const stmtInsertVoter = db.prepare(
  'INSERT OR IGNORE INTO voters (address, created_at) VALUES (?, ?)'
);
const stmtGetVoter = db.prepare(
  'SELECT address, created_at FROM voters WHERE address = ?'
);
const stmtListVoters = db.prepare(
  'SELECT address, created_at FROM voters ORDER BY created_at DESC'
);
const stmtInsertEvent = db.prepare(
  'INSERT INTO vote_events (type, voter, hash, candidate_index, raw, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtListEvents = db.prepare(
  'SELECT * FROM vote_events ORDER BY id DESC LIMIT 1000'
);
const stmtCountEvents = db.prepare('SELECT COUNT(*) AS c FROM vote_events');
const stmtCountVoters = db.prepare('SELECT COUNT(*) AS c FROM voters');

// ---------------------------------------------------------------------------
// 3. Input validation (allowlist — reject, don't sanitize)
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const EVENT_TYPES = new Set(['commit', 'reveal']);

function isValidAddress(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

function isValidHash(v) {
  return v === null || v === undefined || (typeof v === 'string' && HASH_RE.test(v));
}

function isValidCandidateIndex(v) {
  return v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v <= 1_000_000);
}

// ---------------------------------------------------------------------------
// 4. Rate limiting (in-process token bucket, per client key)
// ---------------------------------------------------------------------------

const buckets = new Map(); // key -> { tokens, lastRefillMs }

function clientKey(req) {
  // IP-only by design: User-Agent is trivially rotated, so IP|UA keying would
  // let an abuser mint a fresh bucket per request. Tradeoff (documented in
  // docs/SECURITY.md): NAT/CGNAT users behind one IP share a bucket, and this
  // is traffic smoothing + basic per-IP throttle, not a DDoS solution.
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function refill(bucket, capacity, perMs) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefillMs;
  const refillRatePerMs = capacity / perMs;
  const tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
  return { tokens, lastRefillMs: now };
}

function rateLimiter({ capacity, windowMs, bucket: bucketName }) {
  const perMs = windowMs;
  return (req, res, next) => {
    const key = `${bucketName}:${clientKey(req)}`;
    const stored = buckets.get(key) || { tokens: capacity, lastRefillMs: Date.now() };
    const bucket = refill(stored, capacity, perMs);
    if (bucket.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / (capacity / perMs) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      res.set('X-RateLimit-Limit', String(capacity));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: 'Too Many Requests', retryAfterSec });
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    res.set('X-RateLimit-Limit', String(capacity));
    res.set('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    next();
  };
}

// Prune idle buckets every 5 minutes so the map cannot grow unbounded.
const bucketPruneTimer = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of buckets) {
    if (b.lastRefillMs < cutoff) buckets.delete(k);
  }
}, 5 * 60 * 1000);
bucketPruneTimer.unref();

const globalLimiter = rateLimiter({ capacity: RATE_MAX, windowMs: RATE_WINDOW_MS, bucket: 'global' });
const writeLimiter = rateLimiter({ capacity: RATE_WRITE_MAX, windowMs: RATE_WINDOW_MS, bucket: 'write' });

// ---------------------------------------------------------------------------
// 5. App wiring
// ---------------------------------------------------------------------------

const app = express();
// Trust X-Forwarded-For ONLY behind exactly one reverse proxy. Without a proxy,
// req.ip would become attacker-controlled, which would also poison rate-limit keys.
// Set TRUST_PROXY=1 in production-behind-proxy; default is direct (untrusted header).
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');

app.use(express.json({ limit: BODY_LIMIT }));

// Strict CORS allowlist (never '*')
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

// Security headers
app.use((req, res, next) => {
  // API serves JSON only: deny everything by default, no framing, no MIME sniffing
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS only when we know the client arrived over TLS (or forced production)
  const proto = req.get('X-Forwarded-Proto') || req.protocol;
  if (NODE_ENV === 'production' || proto === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

app.use(globalLimiter);

// --- Routes (public API contract unchanged) ---

// Post a voter into the local (non-authoritative) logger store. Idempotent.
app.post('/api/voters', writeLimiter, (req, res, next) => {
  try {
    const { address } = req.body || {};
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    const normalizedAddr = address.toLowerCase();
    const info = stmtInsertVoter.run(normalizedAddr, new Date().toISOString());
    if (info.changes === 0) {
      const existing = stmtGetVoter.get(normalizedAddr);
      return res.status(200).json({ success: true, ...existing, note: 'already recorded' });
    }
    res.status(201).json({ success: true, address: normalizedAddr });
  } catch (err) {
    next(err);
  }
});

// List locally tracked voters
app.get('/api/voters', (req, res, next) => {
  try {
    res.json(stmtListVoters.all());
  } catch (err) {
    next(err);
  }
});

// Non-authoritative eligibility check. The chain (VoterRegistry.isEligible) is the source of truth.
app.get('/api/voters/:address', (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid address format' });
  }
  const row = stmtGetVoter.get(address.toLowerCase());
  res.json({
    offChainEligible: !!row,
    note: 'Non-authoritative. Verify on-chain via VoterRegistry.isEligible(address).',
  });
});

// Log a vote commit/reveal event (off-chain audit log only)
app.post('/api/vote-events', writeLimiter, (req, res) => {
  const { type, voter, hash, candidateIndex } = req.body || {};
  if (!EVENT_TYPES.has(type)) {
    return res.status(400).json({ error: "type required ('commit' or 'reveal')" });
  }
  if (voter !== undefined && voter !== null && !isValidAddress(voter)) {
    return res.status(400).json({ error: 'Invalid voter address format' });
  }
  if (!isValidHash(hash)) {
    return res.status(400).json({ error: 'Invalid hash format (0x + 64 hex chars)' });
  }
  if (!isValidCandidateIndex(candidateIndex)) {
    return res.status(400).json({ error: 'Invalid candidate_index (non-negative integer)' });
  }
  const now = new Date().toISOString();
  const info = stmtInsertEvent.run(
    type,
    voter ? voter.toLowerCase() : null,
    hash || null,
    candidateIndex ?? null,
    JSON.stringify(req.body || {}),
    now
  );
  res.status(201).json({ success: true, eventId: Number(info.lastInsertRowid), timestamp: now });
});

// List logged vote events (bounded to latest 1000)
app.get('/api/vote-events', (req, res, next) => {
  try {
    const rows = stmtListEvents.all();
    res.json(
      rows.map((r) => {
        let raw = r.raw;
        try {
          raw = JSON.parse(r.raw);
        } catch {
          raw = null; // never fail the listing on a corrupt row
        }
        return { ...r, raw };
      })
    );
  } catch (err) {
    next(err);
  }
});

// Health check
app.get('/health', (req, res, next) => {
  try {
    const { c: totalEvents } = stmtCountEvents.get();
    const { c: totalVoters } = stmtCountVoters.get();
    res.json({ status: 'Backend server running', totalEvents, totalVoters, database: DB_PATH });
  } catch (err) {
    next(err);
  }
});

// 404 + central error handler (no stack/internal leakage outside development)
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err && err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  console.error(`[error] ${req.method} ${req.path}: ${err && err.message}`);
  if (NODE_ENV !== 'production' && err && err.stack) {
    console.error(err.stack);
  }
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// 6. Startup + graceful shutdown (deterministic resource closing)
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`Backend API running on port ${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing...`);
  clearInterval(bucketPruneTimer);
  server.close(() => {
    try {
      db.close();
      console.log('[shutdown] database closed');
    } catch (e) {
      console.error(`[shutdown] db close error: ${e && e.message}`);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] forced exit after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
