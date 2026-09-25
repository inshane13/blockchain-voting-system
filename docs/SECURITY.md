# Security — Blockchain Voting System

Version: 2.2 · Status: implemented (this document describes the code as shipped)

## 1. Threat Model

| Asset | Adversary capability | Control |
|-------|---------------------|---------|
| Vote integrity | Front-running, vote buying | Commit-reveal binding (`abi.encode`, not `encodePacked`) |
| Eligibility | Fake voter registration | On-chain `VoterRegistry` check at commit; backend explicitly non-authoritative |
| API availability | Abuse / accidental floods | Token-bucket limits (IP-only key): 100 req/min global, 10 writes/min; 429 + `Retry-After`. This is traffic smoothing plus a basic per-IP throttle — **not** a DDoS control. Real volumetric defense belongs at the edge (WAF/CDN). Caveats: NAT/proxy users sharing one IP throttle each other; mobile CGNAT rotates IPs, weakening per-IP limits. |
| Injection | SQLi / XSS / oversized payloads | Prepared statements only; regex allowlists; 100kb body cap; 413/400 rejections |
| Clickjacking / sniffing | Malicious framing, MIME confusion | `X-Frame-Options: DENY`, `nosniff`, strict referrer + permissions policies |
| Session riding | CSRF on state-changing POSTs | Same-origin frontend + strict CORS allowlist; no cookies/auth tokens in use |
| Secret leakage | Committed keys, logged secrets | `.env` gitignored (+ `deployments.json`, `frontend/.env.local`); gitleaks-style review before push; salts never leave the browser |

## 2. Cryptography

| Use | Primitive | Notes |
|-----|-----------|-------|
| Commitment | `keccak256(abi.encode(uint256 idx, bytes32 salt))` | Hiding + binding; per-voter storage defeats griefing collisions |
| Salt | `keccak256(bytes(userSecret))` | User memorized; stored in origin-scoped `localStorage`, cleared on reveal |
| Signatures | ECDSA secp256k1 via MetaMask | Backend holds no keys and signs nothing |
| Transit | TLS 1.3 (host-terminated) | App sends HSTS when production/TLS-detected; CSP on frontend |

### Explicitly out of scope (with rationale)
- **At-rest encryption of salts**: salting a browser store adds no security boundary —
  any local attacker who can read `localStorage` already controls the device and the
  MetaMask key that matters. Mitigation is operational: short reveal windows + salt
  deletion on reveal (implemented).
- **HSM/KMS**: no server-side keys exist to manage. If a backend signer is ever added,
  it must go behind a KMS abstraction with short-lived keys — tracked as future work.
- **On-chain pause switch**: omitted by design (immutable election integrity); incident
  response is factory redeploy + voter redirection.

## 3. Input Validation Matrix

| Endpoint / Function | Rule | Failure |
|---------------------|------|---------|
| `POST /api/voters` | `address` matches `^0x[a-fA-F0-9]{40}$` | 400 |
| `GET /api/voters/:address` | same address regex | 400 |
| `POST /api/vote-events` | `type ∈ {commit, reveal}`; optional `voter` address regex; optional `hash` `^0x[a-fA-F0-9]{64}$`; optional non-negative int `candidate_index` | 400 |
| Any JSON body | ≤ 100kb, valid JSON | 413 / 400 |
| `Voting.commit` | phase, not-voted, not-committed, eligible, non-zero hash | custom errors |
| `Voting.reveal` | phase window, not-voted, candidate bounds, hash match | custom errors |

## 4. Supply-Chain Baseline (audited 2026-09-25)

| Workspace | Result | disposition |
|-----------|--------|-------------|
| root (hardhat toolchain) | 48 vulns (18 low / 10 moderate / **20 high**) — transitive `ws` via hardhat/ethers | No non-breaking fix available; engine-pinned env blocks reinstalls. Deferred to toolchain upgrade. |
| backend | 3 vulns (1 low / 1 moderate / **1 high**) — `qs`, `brace-expansion` via express | Same constraint; mitigated in-app by body cap + method allowlist. |
| frontend | 9 vulns (2 moderate / 6 high / **1 critical**) — `ws` via ethers | Same constraint; browser `ws` path unused by the app (HTTP/RPC only). |

Policy: `npm audit --audit-level=high` runs in CI as **informational**
(`continue-on-error`) until the Node ≥22.13 toolchain upgrade unblocks
`npm audit fix`. Lockfiles remain pinned with SHA-512 integrity in the meantime.
Never run `npm audit fix --force` without a full test pass (29 contract tests +
frontend build + backend smoke).

## 5. Secret Management

- Local: gitignored `.env`; `.env.example` files contain placeholders only.
- CI deploy: repository secrets (`SEPOLIA_URL`, `PRIVATE_KEY`, `ETHERSCAN_API_KEY`).
- Rotation: `openssl rand -hex 32` → update secret store → redeploy factory →
  re-register voters. Compromised keys are revoked at the provider (Alchemy dashboard).
- Prohibition: no secrets in chat, issues, docs, or committed files. The 2026-09-25
  incident (test key + Alchemy key posted in chat) was handled by revoking both.

## 6. Runbooks

### DDoS / rate-limit triage
1. Confirm 429s + `X-RateLimit-Remaining: 0` in responses.
2. Check `/health` for event/voter growth anomalies.
3. Tighten `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WRITE_MAX` via env (no redeploy of code).
4. Proxy rule: `TRUST_PROXY=1` **only** behind exactly one trusted reverse proxy.
   Direct exposure without a proxy must leave it unset, otherwise `req.ip` (and
   therefore rate-limit keys) becomes attacker-controlled via `X-Forwarded-For`.

### Suspected contract exploit
1. Read `VoteCommitted`/`VoteRevealed` event stream for anomalous patterns.
2. There is no pause function: deploy a fresh election via the factory, publish the
   new addresses, and have the admin re-register voters.
3. Rotate admin/deployer keys.

### Backend compromise
1. The DB holds only audit data — rotate nothing cryptographic; snapshot `voting.db`.
2. Rebuild from lockfile (`npm ci --legacy-peer-deps`), redeploy, restore or discard audit log.

## 7. Verification Checklist (per release)

- [ ] `npx hardhat compile` clean; `npx hardhat test` 29/29
- [ ] `npx solhint "contracts/**/*.sol"` 0 errors/warnings
- [ ] `frontend: npm run lint` 0 errors; `npm run build` success; prod headers verified (`curl -sI`)
- [ ] Backend smoke: `/health` 200, invalid input 400s, oversize 413, graceful SIGTERM closes DB
- [ ] `npm audit --audit-level=high` reviewed; new highs triaged before merge
- [ ] No secrets in `git status` / diff (`git check-ignore .env frontend/.env.local deployments.json`)
