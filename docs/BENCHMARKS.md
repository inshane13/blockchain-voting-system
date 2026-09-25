# Gas Benchmarks & Scale Projection

**Method**: receipt-based `gasUsed` capture, zero new dependencies (no gas-reporter
plugin, no price oracles). Primary numbers come from the ephemeral Hardhat network;
live Sepolia receipts are appended as a labeled historical sample.
**Contracts frozen** — these numbers describe the shipped bytecode (`05905be` lineage).

> **Asserted-vs-measured flags (standing rule):** an earlier planning note asserted
> `createElection ≈ 1,248,312`, `commit ≈ 48,219`, `reveal ≈ 41,105` **without
> measurement**. Measured values below differ by **+37% / +63% / +85%** — all
> outside the ±20% band, so both figures are published side by side. The measured
> column is authoritative. Plausible cause of the gap: the assertions appear to
> predate the optimizer/bytecode as shipped; cold `SSTORE`s, three string
> candidates, and Ownable dispatch dominate the real costs.

## 1. Measured Execution Gas

| Operation | Hardhat (primary) | Sepolia receipt (historical) | Matches? | Notes |
|---|---|---|---|---|
| `VotingFactory.createElection()` | 1,713,396 | n/a (deploy tx hash not retained) | — | Deploys two full contracts (`Voting` + `VoterRegistry`); cost dominated by bytecode deposit, one-time per election |
| `VoterRegistry.addVoter()` | 47,938 | n/a | — | Cold `SSTORE` whitelist write; repeats per voter |
| `Voting.commit()` | 78,792 | **78,792** (`0xc96b…e3c24`, status 1) | ✅ exact | Stores `commitments[voter]` hash |
| `Voting.reveal()` | 75,895 | **75,895** (`0x7b69…6896`, status 1) | ✅ exact | Two cold slots (`votes[idx]`, `hasVoted`) + one delete (`commits`) ≈ 60k pre-overhead; the +85% delta reflects a pre-bytecode estimate, not a regression |

Reproduce: `npx hardhat run scripts/e2e-local.js` exercises the same paths
(asserted in CI); the scratch capture script used here is intentionally *not*
committed — re-measure with any Hardhat run and read `receipt.gasUsed`.

Takeaway: Hardhat reproduces the Sepolia receipts exactly because both apply the same
EIP-2929/2200 storage schedule to identical calldata and storage state. This validates
the harness as a measurement tool; it does not claim other chains or L2s will produce
identical numbers. Both functions sit far above the ~21k SSTORE floor and far below
block limits — plausible, no measurement bug.

## 2. Scale Projection — the 945M-Voter Problem (§4.3.1)

Using Election Commission of India baseline cited in Manda & Bhukya (2024):
**945,000,000 registered voters.** Per-voter cost (measured):

```
Gas_voter  = Gas_commit + Gas_reveal = 78,792 + 75,895 = 154,687 gas
Gas_total  = 945,000,000 × 154,687 ≈ 1.4618 × 10^14 gas
```

Ethereum L1 constraints (30M block gas limit, ~12s blocks ≈ 2.5M gas/s, 100% of
block space to voting — already an impossible assumption):

```
Throughput_max = 2,500,000 / 154,687 ≈ 16 votes/second   (theoretical maximum at
  100% block space; real deployments share blocks with all other traffic)
Blocks_needed  = 1.4618e14 / 30,000,000 ≈ 4,872,641 blocks
Time_needed    = 4,872,641 / 7,200 blocks/day ≈ 677 days (~1.9 years)
```

**Conclusion**: L1 deployment is strictly bound to small/medium elections
(municipal, enterprise, DAO governance). This validates — with our own numbers —
the paper's finding on L1 throughput limits.

## 3. Layer-2 Note (illustrative, not measured)

Offloading execution to an EVM-equivalent L2 rollup (Arbitrum, Optimism, Base)
typically compresses execution fees by ~90–95%, with L1 acting as data-availability
and finality layer (EIP-4844 blobs). That moves municipal-scale elections into
operational feasibility. No L2 deployment or measurement exists in this repo;
treat this paragraph as direction, not evidence.

## 4. Consolidated Security & Privacy Limitations

| Limitation | Mechanism in this repo | Consequence |
|---|---|---|
| Client salt storage | `salt` persists in `localStorage` until reveal | Unencrypted voting receipt; coercible (see `docs/RESEARCH.md` §4.2) |
| Plaintext public reveal | `reveal` posts `(address, candidate, salt)` on-chain | No post-reveal anonymity; trivial vote linkage via events |
| Centralized whitelist admin | Registry `owner` alone calls `addVoter` | Owner key compromise = eligibility compromise; rotate per runbook |
| No receipt-freeness / ZK / HE | No PETs implemented | Out of scope; see `docs/RESEARCH.md` §4 |
| L1 throughput ceiling | §2 above | Municipal/DAO scale only |

## 5. Re-measurement Procedure

1. `npx hardhat run scripts/e2e-local.js` (exercises commit + reveal).
2. For per-op gas: wrap any call as `const rc = await (await tx).wait()` and print
   `rc.gasUsed`; compare against §1 and flag deltas > ±20% before editing this file.
3. For Sepolia samples: `eth_getTransactionReceipt` on the tx hash; label with hash,
   status, and date. Never present receipt samples as benchmarks.
