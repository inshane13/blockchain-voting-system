# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning](https://semver.org/).

## [2.2.0] — 2026-09-25 — Automation, tests, CI/CD, verified maths (no contract changes)

### Added
- Root `Makefile`: single entry point for install/compile/test/lint/build/smoke/
  e2e/deploy/register/audit/ci/clean (idempotent; secrets never echoed).
- Hardhat suite 29 → 50: full `VotingFactory` describe (10), registry extras (4:
  soft-clear, re-add, zero-remove, owner), getters/math/edges (7: deadline ordering,
  OOB votes, lifecycle flags, math vectors, 2-2-1 tie, conservation, early reveal).
- `backend/test/api.test.js`: 19 API tests on `node:test` (zero new deps), incl. a
  dedicated rate-limit suite (budget headers + 429 + `Retry-After`).
- `scripts/e2e-local.js`: deterministic factory tie + winner + event-enumeration
  E2E, wired to `make e2e-local` and CI.
- `VOTER_ADDR` env support in `scripts/registerVoter.js` (hardhat rejects
  positional CLI args); `make register VOTER=0x...`.
- CI: backend `npm test` step + `e2e-local` job.
- `docs/MATH.md`: commitment math with verified vectors, phase inequalities,
  winner truth table, conservation invariants, re-verification procedure.

### Fixed
- README testing section referenced non-existent scripts (`frontend npm test`,
  root `npm run ci`); now documents the Makefile truthfully.

### Verification
- `make ci` green: 50 contract + 19 backend tests, lint, build, smoke, E2E.

## [2.1.1] — 2026-09-25 — Middleware-order fix + spec convergence (no contract changes)

### Fixed
- Middleware order is now headers → CORS → limiter → parser, so 413/400 responses
  from the body parser carry security headers and pass through the rate limiter
  (previously both controls were structurally bypassed on parser-error paths).
- `swagger.json` now documents the 400/413/429 responses the code actually returns.

### Verification
- 413 + malformed-JSON 400 responses carry CSP/nosniff/DENY + `X-RateLimit-*` headers.
- Full gate re-run: see release commit message.

## [2.1.0] — 2026-09-25 — Security hardening pass (no contract changes)

### Added
- Backend: token-bucket rate limiting (100/min global, 10/min writes, IP-only keys),
  strict CORS allowlist, security headers (CSP/`nosniff`/DENY/referrer/permissions,
  conditional HSTS), allowlist input validation, 100kb body cap, migration table,
  bounded event listing, central error handler, graceful SIGINT/SIGTERM shutdown.
- Backend: `backend/.env.example` documenting all env vars incl. `TRUST_PROXY`.
- Backend: `audit` npm script.
- Frontend: security headers in `next.config.js` (CSP with env-driven RPC origin);
  `NEXT_PUBLIC_BACKEND_URL` env (no hardcoded backend URL); `NotEligible` verified
  on the registry ABI question (registry never emits it — fragment removed).
- CI: `--legacy-peer-deps` TODO comments, guarded smoke-test cleanup, informational
  `npm audit` job.
- Docs: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`; corrected custom-error accounting
  (14 declarations / 14 unique, grep-measured) and winner/tie rule.

### Changed
- `scripts/updateFrontendEnv.js` deleted (superseded by `scripts/deploy.js`, which is
  the sole writer of `frontend/.env.local` and the only path that sets
  `NEXT_PUBLIC_FACTORY_ADDRESS`).
- `GET /api/voters/:address` now returns 400 on malformed addresses (was 200 + false).
- README runbooks corrected: no on-chain pause switch exists; threat matrix no longer
  claims DDoS protection.

### Verification
- `npx hardhat compile` clean · `npx hardhat test` 29/29 · `solhint` 0/0
- `frontend: lint` 0 errors · `build` success · prod headers verified via `curl -sI`
- Backend smoke: `/health` 200, malformed input 400s, oversize 413, SIGTERM closes DB
- Sepolia factory pair unaffected (no contract bytecode changes in this release).

## [1.0.0] — prior baseline
- Commit-reveal voting dApp (27 tests), factory pattern, frontend/backend E2E.
