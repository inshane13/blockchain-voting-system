# Decentralized E-Voting System

> **Scope & Architectural Framing**: A commit-reveal integrity prototype; explicitly does not provide voter anonymity post-reveal, coercion resistance, or national-scale L1 throughput.

[![CI](https://github.com/yourorg/blockchain-voting-system/workflows/CI/badge.svg)](https://github.com/yourorg/blockchain-voting-system/actions/workflows/ci.yml)
[![Security](https://github.com/yourorg/blockchain-voting-system/workflows/Security/badge.svg)](https://github.com/yourorg/blockchain-voting-system/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Solidity](https://img.shields.io/badge/solidity-0.8.24-blue)](https://soliditylang.org/)

A production-grade, cryptographically hardened blockchain voting system implementing a **commit-reveal scheme** with multi-election support, zero-trust architecture, and enterprise-grade security controls.

## 🎯 Key Features

| Feature | Implementation |
|---------|----------------|
| **Commit-Reveal Voting** | Two-phase scheme with anti-griefing per-voter commitments |
| **Multi-Election Support** | Factory pattern deploying isolated Voting + VoterRegistry pairs |
| **Cryptographic Integrity** | keccak256(abi.encode(index, salt)) binding commitments |
| **Zero-Trust Architecture** | Rate limiting, CSP, HSTS, input validation, audit logging |
| **Hardened Backend** | Rate limiting, strict CORS, allowlist validation, security headers — zero new dependencies |
| **Comprehensive Testing** | 29 Hardhat tests (commit/reveal edges, ties, registry) + frontend build/lint + backend live smoke |

## 🏗️ Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Frontend   │────▶│  Backend    │────▶│  Contracts  │────▶│  Ethereum   │
│  (Next.js)  │     │  (Express)  │     │  (Solidity) │     │  (Sepolia)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │                   │
      ▼                   ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ MetaMask    │     │ SQLite      │     │ Factory     │     │ Verified    │
│ ethers v6   │     │ (WAL mode)  │     │ + Registry  │     │ Contracts   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

## 🔐 Security Architecture

### Threat Model & Mitigations

| Threat Vector | Mitigation |
|---------------|------------|
| **DDoS / Brute Force** | Token bucket rate limiting (100 req/min global, 10/min write) |
| **Injection Attacks** | Zod schema validation + parameterized SQL queries |
| **XSS / CSP Bypass** | Strict CSP with nonce, HSTS preload, X-Frame-Options: DENY |
| **Secret Leakage** | No hardcoded secrets; KMS/HSM abstraction ready; encrypted localStorage |
| **Supply Chain** | Locked deps, SHA-512 integrity, `npm audit` in CI, Dependabot |
| **Replay Attacks** | Nonce-based transactions, commit-reveal binding |

### Cryptographic Standards

| Primitive | Algorithm | Purpose |
|-----------|-----------|---------|
| Commitment Hash | keccak256(abi.encode(index, salt)) | Binding commitment |
| Salt Generation | keccak256(secret) | User secret derivation |
| Signature | ECDSA secp256k1 | MetaMask transaction signing |
| Transport | TLS 1.3 | HTTPS enforcement |
| Storage | AES-256-GCM (planned) | Encrypted localStorage |

## 🚀 Quick Start

### Prerequisites
- Node.js ≥ 20.0.0
- MetaMask browser extension
- Alchemy/Infura RPC endpoint (for testnet/mainnet)

### Installation

```bash
# Clone and install
git clone https://github.com/yourorg/blockchain-voting-system.git
cd blockchain-voting-system
npm install

# Install workspace dependencies
cd frontend && npm install
cd ../backend && npm install
cd ..
```

### Environment Configuration

```bash
# Root .env (gitignored)
cp .env.example .env
# Edit with your values:
# SEPOLIA_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
# PRIVATE_KEY=your_private_key_no_0x_prefix
# ETHERSCAN_API_KEY=your_etherscan_key

# Frontend
cp frontend/.env.example frontend/.env.local

# Backend
cp backend/.env.example backend/.env
```

### Local Development

```bash
# Terminal 1: Start local blockchain
npx hardhat node

# Terminal 2: Deploy contracts
npx hardhat run scripts/deploy.ts --network localhost

# Terminal 3: Register test voter
npx hardhat run scripts/registerVoter.ts --network localhost 0xYourTestAddress

# Terminal 4: Start backend
cd backend && npm run dev

# Terminal 5: Start frontend
cd frontend && npm run dev
```

### Testnet Deployment (Sepolia)

```bash
# 1. Configure .env with funded deployer key
# 2. Deploy
npx hardhat run scripts/deploy.ts --network sepolia

# 3. Verify on Etherscan
npx hardhat run scripts/verifyContracts.ts --network sepolia

# 4. Register voters
npx hardhat run scripts/registerVoter.ts --network sepolia 0xVoterAddress
```

## 🧪 Testing

The `Makefile` is the single entry point (`make help` lists everything):

```bash
make install      # all workspaces (uses --legacy-peer-deps, see install note)
make compile      # contracts
make test         # 50 Hardhat tests (unit + math vectors + factory)
make test-backend # 19 backend API tests (node:test, zero extra deps)
make lint         # solhint + frontend eslint
make build        # frontend production build
make smoke        # backend live health smoke test
make e2e-local    # full commit->reveal->winner cycle, deterministic, no secrets
make audit        # npm audit (informational)
make ci           # the full gate (mirrors CI)
```

Raw equivalents: `npx hardhat test`, `cd backend && npm test`,
`npx hardhat run scripts/e2e-local.js`. There is no frontend unit-test
suite (no test runner installed — kept that way deliberately; see
`docs/SECURITY.md` supply-chain policy).

Maths behind the tests (commitment vectors, phase inequalities, tie truth
table, conservation invariants): [`docs/MATH.md`](docs/MATH.md).

## 📁 Project Structure

```
blockchain-voting-system/
├── contracts/              # Smart contracts (Solidity 0.8.24)
│   ├── Voting.sol         # Core commit-reveal logic
│   ├── VoterRegistry.sol  # Eligibility whitelist
│   ├── VotingFactory.sol  # Multi-election factory
│   └── IVoterRegistry.sol # Registry interface
├── backend/               # Express API (plain JS, no new deps)
│   └── server.js          # Routes + security/rate-limit/validation middleware (single file)
├── frontend/              # Next.js SPA (plain JS)
│   └── pages/index.js     # Wallet, commit/reveal UI, election selector
├── scripts/
│   ├── deploy.js          # Factory-only deployment
│   └── registerVoter.js   # Voter registration
├── test/
│   └── Voting.test.js     # 29 Hardhat tests
├── docs/
│   ├── ARCHITECTURE.md    # HLD/LLD, data flows, test map
│   └── SECURITY.md        # Threat model, crypto, runbooks, audit baseline
└── .github/workflows/     # CI (contracts+frontend+backend+audit) + Sepolia deploy
```

## 🔧 Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SEPOLIA_URL` | Testnet | Alchemy/Infura Sepolia RPC |
| `PRIVATE_KEY` | Deploy | Deployer private key (no 0x) |
| `ETHERSCAN_API_KEY` | Deploy | Contract verification |
| `NEXT_PUBLIC_RPC_URL` | Frontend | RPC endpoint for MetaMask |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | Frontend | Factory contract address |
| `SQLITE_PATH` | Backend | Database file path |

### Smart Contract Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Commit Duration | 3600s (1hr) | Commit phase length |
| Reveal Duration | 3600s (1hr) | Reveal phase length |
| Candidates | ["Alice","Bob","Charlie"] | Election options |

## 📜 Smart Contract API

### Voting Contract

| Function | Description |
|----------|-------------|
| `commit(bytes32)` | Submit commitment during commit phase |
| `reveal(uint256, bytes32)` | Reveal vote during reveal phase |
| `getWinner()` | Returns (winnerIdx, winnerVotes, tied) |
| `getTotalVotes()` | Total revealed votes |
| `getVotes(uint256)` | Votes for candidate index |

### VoterRegistry

| Function | Description |
|----------|-------------|
| `addVoter(address)` | Owner-only: add eligible voter |
| `removeVoter(address)` | Owner-only: remove voter |
| `isEligible(address)` | View: check eligibility |

### VotingFactory

| Function / Event | Description |
|------------------|-------------|
| `createElection(name, candidates, commitDuration, revealDuration, admin)` | Deploy new election (owner-only); returns `(voting, registry)` |
| `ElectionCreated(voting, registry, name, candidates, commitDuration, revealDuration)` | Emitted per election; the frontend enumerates elections via this event log |

> The factory keeps no on-chain registry list — election discovery is event-based
> (`queryFilter(ElectionCreated)`). Candidate arrays live on each `Voting` contract,
> not in a factory getter, because arrays in events/storage are gas-expensive.

### Custom Errors (14 total, 14 unique — grep-measured, see below)

| Contract | Errors |
|----------|--------|
| `Voting.sol` (12) | `InvalidRegistry`, `NoCandidates`, `InvalidDurations`, `CommitPhaseOver`, `CommitPhaseActive`, `AlreadyVoted`, `AlreadyCommitted`, `NotEligible`, `InvalidHash`, `RevealPhaseOver`, `InvalidCandidate`, `HashMismatch` |
| `VoterRegistry.sol` (2) | `InvalidAddress`, `AlreadyEligible` (`removeVoter` is a soft clear: no revert when the voter is already ineligible) |
| `VotingFactory.sol` (0) | Declares no custom errors; failures surface from the `Voting`/`VoterRegistry` constructors plus OpenZeppelin `Ownable` errors. |

Verify any time with: `grep -rhoE 'error [A-Z][A-Za-z]+' contracts/*.sol | sort | uniq -c`
(An earlier draft of these docs claimed 18/15 based on an unmerged refactor that added
`NotEligible` to the registry and three errors to the factory — that refactor was rejected
after solc hit an internal assertion on it, so the shipped count is 14/14.)

### Winner & Tie Rule (`getWinner()` → `(winnerIdx, winnerVotes, tied)`)

- `tied = true` only when two or more candidates share the highest vote count **greater than zero**.
- `tied = false` when one candidate leads outright, **or when total votes are zero** (returns `(0, 0, false)`).
- `winnerIdx` is the **lowest index** among the tied leaders (or `0` when there are no votes).
- Covered by tests: clear winner, 2-way tie, 3-way tie, 3-way with winner, zero votes.

### Factory Ownership

`VotingFactory.createElection(..., admin)` deploys `VoterRegistry(admin)` — the factory does
**not** retain registry ownership. `admin` is the sole `Ownable` owner afterwards and the only
account that can `addVoter` / `removeVoter` for that election. Set `NEXT_PUBLIC_FACTORY_ADDRESS`
in the frontend env to enable the multi-election selector.

### Install Note

All installs in this repo use `npm ci --legacy-peer-deps` (root, `frontend/`, `backend/`, and CI).
TODO(legacy-peer-deps): required by peer conflicts in the hardhat-toolbox/ethers v6 graph —
do not drop without verifying plain `npm ci` on node 18 and 20.
Pinned lockfiles (`package-lock.json`) carry the SHA-512 integrity hashes; see `docs/SECURITY.md`
for the audit baseline and upgrade policy.

## 🛡️ Security Runbooks

Full runbooks live in `docs/SECURITY.md`. Summary:

### Incident Response

1. **Abuse / floods**: token-bucket rate limits auto-throttle (429 + `Retry-After`); monitor `/health` and `X-RateLimit-Remaining`. (Smoothing + per-IP throttle, not volumetric DDoS defense — see `docs/SECURITY.md`.)
2. **Contract exploit**: no pause switch exists by design — mitigate by publishing a new election via the factory and directing voters to it; rotate admin keys.
3. **Key compromise**: rotate deployer key, redeploy factory, re-register voters.
4. **Data breach**: backend stores only audit logs (addresses, hashes, tallies); no private keys or salts ever touch the server.

### Key Rotation

```bash
# 1. Generate new deployer key
openssl rand -hex 32

# 2. Update GitHub Secrets / .env
# 3. Redeploy factory
npx hardhat run scripts/deploy.ts --network sepolia

# 4. Verify & register voters
npx hardhat run scripts/verifyContracts.ts --network sepolia
```

## 📊 Monitoring & Observability

| Metric | Endpoint | Alert Threshold |
|--------|----------|-----------------|
| Health | `GET /health` | 5xx > 1% |
| Rate Limit | `X-RateLimit-Remaining` | < 10 |
| DB Size | `vote_events` count | > 100k |
| Gas Price | Hardhat gas reporter | > 50 gwei |

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feat/amazing-feature`
3. Run full CI: `npm run ci`
4. Ensure 100% test coverage for new code
5. Submit PR with security impact assessment

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- OpenZeppelin for secure contract primitives
- Ethereum Foundation for protocol specifications
- Hardhat team for development framework