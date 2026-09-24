const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'voting.db');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS voters (
    address TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vote_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    voter TEXT,
    hash TEXT,
    candidate_index INTEGER,
    raw TEXT,
    created_at TEXT NOT NULL
  );
`);

app.use(cors());
app.use(express.json());

// Post a voter into the local (non-authoritative) logger store
app.post('/api/voters', (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ error: 'Address required' });
  }
  const info = db
    .prepare('INSERT OR IGNORE INTO voters (address, created_at) VALUES (?, ?)')
    .run(address.toLowerCase(), new Date().toISOString());
  if (info.changes === 0) {
    return res.status(400).json({ error: 'Voter already registered' });
  }
  res.status(201).json({ success: true, address });
});

// List locally tracked voters
app.get('/api/voters', (req, res) => {
  const rows = db.prepare('SELECT address, created_at FROM voters ORDER BY created_at DESC').all();
  res.json(rows);
});

// Non-authoritative eligibility check. The chain (VoterRegistry.isEligible) is the source of truth.
app.get('/api/voters/:address', (req, res) => {
  const { address } = req.params;
  const row = db.prepare('SELECT address FROM voters WHERE address = ?').get(address.toLowerCase());
  res.json({
    offChainEligible: !!row,
    note: 'Non-authoritative. Verify on-chain via VoterRegistry.isEligible(address).'
  });
});

// Log a vote commit/reveal event (off-chain audit log only)
app.post('/api/vote-events', (req, res) => {
  const { type, voter, hash, candidateIndex } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: 'type required' });
  }
  const now = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO vote_events (type, voter, hash, candidate_index, raw, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      type,
      voter || null,
      hash || null,
      candidateIndex ?? null,
      JSON.stringify(req.body || {}),
      now
    );
  res.status(201).json({ success: true, eventId: Number(info.lastInsertRowid), timestamp: now });
});

// List logged vote events
app.get('/api/vote-events', (req, res) => {
  const rows = db.prepare('SELECT * FROM vote_events ORDER BY id DESC').all();
  res.json(rows.map((r) => ({ ...r, raw: JSON.parse(r.raw) })));
});

// Health check
app.get('/health', (req, res) => {
  const { c: totalEvents } = db.prepare('SELECT COUNT(*) AS c FROM vote_events').get();
  const { c: totalVoters } = db.prepare('SELECT COUNT(*) AS c FROM voters').get();
  res.json({ status: 'Backend server running', totalEvents, totalVoters, database: DB_PATH });
});

app.listen(PORT, () => {
  console.log(`Backend API running on port ${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});