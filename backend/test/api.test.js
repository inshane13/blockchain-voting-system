/**
 * Backend API suite — runs on the built-in node:test runner, zero extra deps.
 * Spawns `node server.js` on an ephemeral port (54321) with an isolated
 * SQLite file, then exercises every route including validation, idempotency,
 * rate-limit headers and security headers.
 *
 * Run:  node --test test/        (or `make test-backend` / `npm run test`)
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 54321;
const BASE = `http://localhost:${PORT}`;
const VOTER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HASH = '0x' + 'ab'.repeat(32);

let server;
let tmpDb;

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('backend did not become healthy in time');
}

before(async () => {
  tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voting-test-')), 'test.db');
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SQLITE_PATH: tmpDb,
      ALLOWED_ORIGINS: 'http://localhost:3000',
      // Generous budgets so validation tests never trip the limiter;
      // throttling itself is covered by the dedicated suite below.
      RATE_LIMIT_MAX_REQUESTS: '10000',
      RATE_LIMIT_WRITE_MAX: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await waitForHealth();
});

after(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    if (!server.killed) server.kill('SIGKILL');
  }
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('health', () => {
  it('returns status, counts and database path', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'Backend server running');
    assert.equal(body.totalEvents, 0);
    assert.equal(body.totalVoters, 0);
    assert.ok(typeof body.database === 'string');
  });

  it('sends security headers and no server fingerprint', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.ok((r.headers.get('content-security-policy') || '').includes("default-src 'none'"));
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('emits rate-limit headers', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.ok(r.headers.get('x-ratelimit-limit'));
    assert.ok(r.headers.get('x-ratelimit-remaining') !== null);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const r = await fetch(`${BASE}/nope`);
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /not found/i);
  });
});

describe('voters', () => {
  it('rejects missing address with 400', async () => {
    const r = await fetch(`${BASE}/api/voters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  it('rejects malformed addresses with 400 (no pattern leak)', async () => {
    for (const bad of ['zzz', '0x123', 12345, null]) {
      const r = await fetch(`${BASE}/api/voters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: bad }),
      });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal((await r.json()).error, 'Invalid address');
    }
  });

  it('creates a voter with 201 and lowercases the address', async () => {
    const r = await fetch(`${BASE}/api/voters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: VOTER }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.success, true);
    assert.equal(body.address, VOTER.toLowerCase());
  });

  it('is idempotent: duplicate returns 200 + already recorded', async () => {
    const r = await fetch(`${BASE}/api/voters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: VOTER.toLowerCase() }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.note, 'already recorded');
    assert.equal(body.address, VOTER.toLowerCase());
  });

  it('lists voters', async () => {
    const r = await fetch(`${BASE}/api/voters`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.ok(rows.some((row) => row.address === VOTER.toLowerCase()));
  });

  it('reports off-chain eligibility with non-authoritative note', async () => {
    const r = await fetch(`${BASE}/api/voters/${VOTER}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.offChainEligible, true);
    assert.match(body.note, /non-authoritative/i);
  });

  it('reports unknown addresses as ineligible', async () => {
    const r = await fetch(`${BASE}/api/voters/0x0000000000000000000000000000000000000001`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).offChainEligible, false);
  });

  it('rejects malformed path addresses with 400', async () => {
    const r = await fetch(`${BASE}/api/voters/not-an-address`);
    assert.equal(r.status, 400);
  });
});

describe('rate limiting', () => {
  const SMALL_PORT = 54322;
  const SMALL_BASE = `http://localhost:${SMALL_PORT}`;
  let small;
  let smallDb;

  before(async () => {
    smallDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voting-ratelimit-')), 'test.db');
    small = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(SMALL_PORT),
        SQLITE_PATH: smallDb,
        RATE_LIMIT_MAX_REQUESTS: '1000',
        RATE_LIMIT_WRITE_MAX: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    small.stdout.on('data', () => {});
    small.stderr.on('data', () => {});
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${SMALL_BASE}/health`);
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('rate-limit backend did not become healthy');
  });

  after(async () => {
    if (small && !small.killed) {
      small.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (!small.killed) small.kill('SIGKILL');
    }
    try { fs.rmSync(path.dirname(smallDb), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('allows writes under budget with remaining-budget headers', async () => {
    const mkVoter = (n) => `0x${n.toString(16).padStart(40, '0')}`;
    for (const addr of [mkVoter(1), mkVoter(2)]) {
      const r = await fetch(`${SMALL_BASE}/api/voters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      assert.equal(r.status, 201);
      assert.equal(r.headers.get('x-ratelimit-limit'), '2');
    }
  });

  it('returns 429 + Retry-After once the write budget is spent', async () => {
    const r = await fetch(`${SMALL_BASE}/api/voters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: `0x${'3'.repeat(40)}` }),
    });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, 'Too Many Requests');
    assert.ok(r.headers.get('retry-after') !== null);
    assert.equal(r.headers.get('x-ratelimit-remaining'), '0');
  });
});

describe('vote-events', () => {
  it('rejects unknown types with 400', async () => {
    const r = await fetch(`${BASE}/api/vote-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'hack' }),
    });
    assert.equal(r.status, 400);
  });

  it('rejects malformed voter/hash/candidate fields with 400', async () => {
    const bad = [
      { type: 'commit', voter: 'nope' },
      { type: 'commit', hash: '0x123' },
      { type: 'reveal', candidateIndex: -1 },
      { type: 'reveal', candidateIndex: 1.5 },
    ];
    for (const payload of bad) {
      const r = await fetch(`${BASE}/api/vote-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
  });

  it('logs a commit event and lists it back with parsed raw', async () => {
    const post = await fetch(`${BASE}/api/vote-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'commit', voter: VOTER, hash: HASH }),
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    assert.equal(created.success, true);
    assert.ok(Number.isInteger(created.eventId));

    const list = await fetch(`${BASE}/api/vote-events`);
    assert.equal(list.status, 200);
    const rows = await list.json();
    const found = rows.find((row) => row.id === created.eventId);
    assert.ok(found);
    assert.equal(found.type, 'commit');
    assert.equal(typeof found.raw, 'object');
    assert.equal(found.raw.type, 'commit');
  });

  it('rejects oversize bodies with 413', async () => {
    const big = { type: 'commit', raw: 'x'.repeat(200_000) };
    const r = await fetch(`${BASE}/api/vote-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(big),
    });
    assert.equal(r.status, 413);
  });

  it('rejects malformed JSON with 400', async () => {
    const r = await fetch(`${BASE}/api/vote-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(r.status, 400);
  });
});
