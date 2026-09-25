# Architecture — Blockchain Voting System

Version: 2.1 · Status: implemented (this document describes the code as shipped)

## 1. System Overview

A commit-reveal voting dApp with three runtime layers plus the blockchain:

```
Browser (Next.js SPA + MetaMask/ethers v6)
  │  HTTPS/WSS (TLS terminated at host) + REST
  ▼
Backend (Express + better-sqlite3, WAL) — OFF-CHAIN AUDIT LOG ONLY
  │  read-only RPC / signed user txs via MetaMask
  ▼
Ethereum (Sepolia / localhost)
  VotingFactory (singleton) → Voting + VoterRegistry (one pair per election)
```

Authoritative state lives **on-chain only**: eligibility (`VoterRegistry.isEligible`),
commitments, tallies, winner. The backend never gates voting rights.

## 2. Trust Boundaries

| # | Boundary | Controls |
|---|----------|----------|
| T1 | Browser → Backend | TLS (host), strict CORS allowlist, rate limits, 100kb body cap, allowlist input validation |
| T2 | Backend → SQLite | Parameterized prepared statements only; single long-lived handle; WAL mode |
| T3 | Browser → Chain | MetaMask-signed txs; contract-side eligibility + phase checks (never trust the UI) |
| T4 | Backend → Chain | None — backend holds no keys and makes no chain calls |

## 3. Component Map (HLD)

- **Presentation** (`frontend/`): `pages/index.js` (single page), ethers v6, `@metamask/detect-provider`.
  Salt persisted per-account in `localStorage`, cleared after reveal. Factory elections
  enumerated from `ElectionCreated` event logs; election switcher dropdown.
- **Edge/gateway** (`backend/server.js`): Express with in-house middleware —
  `securityHeaders`, token-bucket `globalLimiter` (100/min) + `writeLimiter` (10/min),
  Zod-free regex allowlist validation, central error handler (no stack leaks in prod).
- **Business core** (`contracts/`): `Voting.sol` (commit/reveal/tally/winner),
  `VoterRegistry.sol` (Ownable whitelist + batch add), `VotingFactory.sol`
  (isolated pair deployment), `IVoterRegistry.sol` (decoupling interface).
- **Persistence** (`backend/data/voting.db`): `voters`, `vote_events`, `migrations`
  tables; indexes on voter/type/created.

## 4. Data Flow (LLD)

### 4.1 Commit
1. UI: `salt = keccak256(bytes(userString))`; `hash = keccak256(abi.encode(idx, salt))`.
2. UI → `Voting.commit(hash)`. Contract checks, in order: phase → `hasVoted` →
   `hasCommitted` → `isEligible` → non-zero hash. Stores per-voter commitment.
3. UI → `POST /api/vote-events {type: commit, voter, hash}` (audit only).
4. UI persists raw salt string in `localStorage` for the reveal phase.

### 4.2 Reveal
1. UI reloads saved salt (or user input) → `Voting.reveal(idx, salt)`. Contract checks:
   phase window (reveal includes exact `commitDeadline`) → `hasVoted` → candidate
   bounds → `keccak256(abi.encode(idx, salt)) == storedCommit`. Increments tally,
   marks voted, deletes commitment.
2. UI → `POST /api/vote-events {type: reveal, ...}`. Clears stored salt.

### 4.3 Winner
`getWinner()` is an ungated O(N) view: tracks max votes; `tied=true` iff ≥2 candidates
share the max **and** max > 0; `winnerIdx` = lowest index at max (0 when no votes).
`getTotalVotes()` sums tallies. See README § Winner & Tie Rule.

## 5. Error Propagation

- Contracts → 14 custom errors, all unique (see README table) → ethers `parseError` via
  `VOTING_INTERFACE` / `REGISTRY_INTERFACE` / `FACTORY_INTERFACE` in `describeError()`.
- Backend → `{error, message}` JSON with correct status (400 validation, 404 unknown
  route, 409 conflict, 413 oversize, 429 rate-limited, 500 generic). Stack traces only
  in non-production logs.
- Frontend → banner errors with decoded custom-error names; success toasts on receipts.

## 6. Resource Lifecycle (OS hygiene)

- SQLite: one handle, `busy_timeout`, WAL; closed on SIGINT/SIGTERM after HTTP drain
  (10s forced-exit backstop).
- Rate-limiter buckets: pruned every 5 min (unref'd timer); bounded memory.
- Ethers listeners: `removeAllListeners` on re-init; `off()` on effect cleanup.
- No background threads/workers; single-threaded Node event loop, all-async I/O.

## 7. Deployment Topology

- Local: `hardhat node` + `scripts/deploy.js --network localhost`.
- Testnet: `scripts/deploy.js --network sepolia` (factory → `createElection` →
  parse `ElectionCreated` → `deployments.json` + `frontend/.env.local`).
- Voters: `scripts/registerVoter.js` (defaults to deployer).
- Secrets: local gitignored `.env`; CI via repository secrets. Never committed.

## 8. Test Map (29 Hardhat tests)

Deployment (4) · commit phase (5 incl. deadline edge + double-commit) · reveal (8 incl.
exact-boundary, wrong-salt, no-commit, post-deadline, collision) · eligibility (1) ·
winner (5: clear, 2-way tie, 3-way tie, 3-way-with-winner, zero votes) · registry (6).
Plus: frontend build+lint, backend live `/health` smoke in CI.
