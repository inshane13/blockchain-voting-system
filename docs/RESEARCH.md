# Academic Research Mapping & Architectural Scope

**Snapshot Information**
- **Version**: `2.3.0` (docs release; shipped contracts unchanged since `05905be`)
- **Snapshot Date**: September 25, 2026
- **Live Sepolia deployment (D3)**: factory `0x0F621760C56679d92E53D5ff13ba7802ccC1A08c`,
  voting `0xE3530F7DCE4d72Ad71D2f4D2A3EBE3eE205AA2A4`,
  registry `0x7663c7ac3063E52F7C3e7Ba410c26b72Cb97e588`
- **Protocol State**: Core smart contracts frozen

> Deployment lineage (roles never swapped): D1 (`0xc368…` factory / `0xa209…` voting /
> `0xBAD1…` registry) holds the fully-voted election used in the observer runbook
> (`docs/VERIFY.md`); D2 (`0xE2a9…` / `0x8382…`) is superseded; **D3 above is live**.
> This doc snapshots the **current** deployment; the runbook targets D1. Same
> contracts, different deployments — that split is intentional.

---

## 1. Executive Context & Academic Citation

This document maps the system architecture of this repository against current literature
synthesized in:

> **Primary Reference**:
> Manda, V. K., & Bhukya, M. (2024). Meta-analysis of blockchain-powered electronic voting systems. *MATEC Web of Conferences*, 392, 01076.
> [https://doi.org/10.1051/matecconf/202439201076](https://doi.org/10.1051/matecconf/202439201076)

### Methodological & Scope Boundary
The meta-analysis by Manda & Bhukya (2024) synthesizes research trends across 88 peer-reviewed studies (2019–2023) focusing on security, transparency, and voter privacy in blockchain-based e-voting. This repository uses the paper's qualitative taxonomy, structural trade-offs, and open research challenges as a benchmarking standard. Quantitative publication counts cited in the paper are excluded due to the absence of a PRISMA flowchart in the source text.

---

## 2. Technical Coverage Matrix

| Paper Theme & Taxonomy | Repo Implementation State | Architectural Verdict |
| :--- | :--- | :--- |
| **EVM Stack Standard** (§3.1.5) | Ethereum (Solidity `0.8.24` / Hardhat / `ethers.js` v6 / MetaMask). | **Aligned**: Direct match with established EVM smart contract standards. |
| **Tamper-Evident Tally & Verifiability** (§4.1) | On-chain getters (`getVotes`, `getWinner`, `getTotalVotes`) and emitted events (`VoteCommitted`, `VoteRevealed`). 50 contract tests passing (see counting note below). | **Aligned**: Immutable on-chain state transition with audit trails. |
| **Voter Eligibility & Auth** (§1.2, §3.1.3) | `VoterRegistry.sol` whitelist managed by contract owner, enforced prior to commit phase. | **Aligned**: Minimal deterministic authorization primitive. |
| **Commit-Reveal Mechanism** (§4.1) | Two-phase state machine using `hash = keccak256(abi.encode(candidateIndex, salt))`. | **Aligned**: Protects tally confidentiality prior to reveal deadline. |
| **Privacy-Enhancing Techniques (PETs)** (§3.1.7) | None implemented; choice is public on-chain post-reveal. | **Explicit Gap**: Does not implement Homomorphic Encryption (HE), Ring Signatures, or Zero-Knowledge Proofs (ZKPs). |
| **Coercion Resistance & Receipt-Freeness** (§4.1) | Absent; `salt` persisted in browser `localStorage` acts as a voting receipt. | **Explicit Gap**: Vulnerable to voter coercion if forced to disclose salt. |
| **Universal Verifiability** (§4.1) | Public state inspection via RPC or block explorer. | **Partial**: Provides public inclusion and tally proofs, but lacks individual anonymous inclusion proofs. |
| **Scalability Constraints** (§4.3.1) | 2 on-chain transactions per voter on Ethereum L1. | **Explicit Gap**: Subject to L1 gas and throughput limits; infeasible for national scale (945M voters). |
| **Factory / Multi-Election Pattern** (§3.1.6) | `VotingFactory.sol` creates isolated `Voting` and `VoterRegistry` contract pairs per election. | **Aligned**: Prevents state mutation and cross-election data pollution. |
| **Backend Architecture** (§4.1) | Non-authoritative Express audit logger without private key access or write authority over contract state. | **Superior Pattern**: Avoids the over-trusting centralized API anti-pattern noted in literature. |

> **Counting note (test inventory).** Count contract tests with
> `grep -cE '^\s*it\(' test/Voting.test.js` **plus** one inline `it(` sharing a line
> (a cosmetic wart from an earlier patch; 49 + 1 = 50). The naive `grep -c "it("`
> returns ~97 because it also matches `.wait(` — never use it. Backend suite:
> 19 `it(` in `backend/test/api.test.js` (`node:test` runner).

---

## 3. Policy & Governance Considerations (§4.2)

| Policy Realm (§4.2) | Literature Benchmark | Repository Scope & Boundary |
| :--- | :--- | :--- |
| **Legal & Regulatory Frameworks** (§4.2.3) | Existing election laws require updates for system certification, auditing standards, and dispute resolution. | **Out of Scope**: Software prototype only. Does not comply with legal election standards or statutory audit requirements. |
| **International Cooperation & Standards** (§4.2.5) | Interoperable cross-jurisdiction standards and standardized cryptographic benchmarks are required. | **Out of Scope**: Adheres to standard EVM ERC/EIP guidelines rather than international electoral standards. |
| **Accessibility & Digital Divide** (§4.2.6) | Online systems risk disenfranchising populations without internet access or technical literacy. | **Partial**: Frontend includes accessibility markers and voter education panels, but requires web access and Web3 wallet setup. |

---

## 4. Explicit Non-Goals & Scope Boundaries

To prevent architectural misinterpretation, the scope of this repository is defined by the following non-claims:

1. **Not an Anonymous Voting System**:
   Per §3.1.7 of the paper, privacy-preserving systems utilize Zero-Knowledge Proofs or Ring Signatures to disconnect voter identity from vote choices. In this implementation, the `revealVote` transaction reveals the voter's address, chosen candidate, and salt in plaintext on-chain.

2. **Not Coercion-Resistant or Receipt-Free**:
   Per §4.1 of the paper, coercion resistance requires that a voter cannot prove to a third party how they voted. Here, storing the deterministic `salt` in client storage provides a verifiable receipt that can be coerced or audited post-hoc.

3. **Not Designed for National-Scale L1 Throughput**:
   Per §4.3.1 of the paper, processing nationwide elections (e.g., India's 945M registered voters) on Ethereum L1 is bottlenecked by block gas limits and transaction execution throughput. This implementation is scoped for municipal, enterprise, or DAO-scale governance elections.

---

## 5. System Architecture Summary

```
+-----------------------------------------------------------------------+
|                        VOTER BROWSER / DAPP                           |
|  1. Generate local salt entropy                                       |
|  2. keccak256(abi.encode(candidateIndex, salt)) -> commitmentHash     |
+-----------------------------------+-----------------------------------+
                                      |
Phase 1: Commit     | Phase 2: Reveal
(Commitment Hash)   | (Index + Salt)
                                      v
+-----------------------------------------------------------------------+
|                        ETHEREUM SMART CONTRACTS                       |
|  • VotingFactory.sol  : Multi-election deployment                     |
|  • VoterRegistry.sol : On-chain eligibility whitelist                 |
|  • Voting.sol        : Two-phase state machine & public tally         |
+-----------------------------------+-----------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------+
|                     NON-AUTHORITATIVE AUDIT LOG                       |
|  • Express / SQLite (WAL) read-only observer backend                  |
+-----------------------------------------------------------------------+
```

---

## 6. Document Maintenance

Re-stamp the snapshot header only on protocol releases or new factory deployments.
Bump this document's claims only from measured repo state (test counts via the
command in the counting note; addresses from `deployments.json`, never memory).
