# Observer Verification Runbook — Verify a Tally Without a Wallet

**Scope.** Primary path targets the **D1 historical deployment** (fully voted):
factory `0xc368c5f4BdBFc80067EdcC2085E9D73193ea730c`,
voting `0xa2095f936A6cD1C31A35e1980dbE8D437AEDBE05`,
registry `0xBAD16caF2ab039a6373b341c484FcC2c19f2732a` — it holds a completed
election, which is what a tally check needs. The **D3 live deployment**
(factory `0x0F621760C56679d92E53D5ff13ba7802ccC1A08c`,
voting `0xE3530F7DCE4d72Ad71D2f4D2A3EBE3eE205AA2A4`,
registry `0x7663c7ac3063E52F7C3e7Ba410c26b72Cb97e588`) is covered in its own
section below. Same contracts, different deployments. (Superseded D2:
`0xE2a9…` / `0x8382…` — retained here so old links resolve instead of dangling.)

**Etherscan verification: unconfirmed.** If the contracts show a green "Contract
Source Code Verified" badge, use the Read Contract / Events tabs directly. If
not, use the ABI fallback (ABIs in `artifacts/contracts/Voting.sol/Voting.json`;
one `npx hardhat verify --network sepolia <address> <constructor args>` with
`ETHERSCAN_API_KEY` verifies them — an ops task, not a code change).

**Key hygiene.** The Sepolia deployer key used for these test deployments was
posted in chat during development and must be treated as **compromised**:
rotation is **recommended and pending**. Rotate before any staging or production
use (`openssl rand -hex 32` → fund only at deploy time → update secret store).
Nothing in this runbook needs a private key — every step below is read-only.

All addresses are Sepolia (chain ID 11155111).

---

## Tier 1 — Explorer UI (no wallet, non-technical)

Use [Sepolia Etherscan](https://sepolia.etherscan.io) (or Blockscout).

### 1.1 Read the tally — Voting `0xa2095f936A6cD1C31A35e1980dbE8D437AEDBE05`

1. Open the address → **Contract** tab → **Read Contract**.
2. Call `getVotes` with `0`, `1`, `2` → expect **1, 0, 0**.
3. Call `getWinner` → expect **`(0, 1, false)`** (Alice, one vote, no tie).
4. Call `getTotalVotes` → expect **1**.
5. Call `getName` → `General Election`; `getCandidates` → `["Alice","Bob","Charlie"]`.

If every value matches, the tally is verified: no wallet, no code, no trust in
any server — you read contract storage directly.

### 1.2 Read the event trail — same address, Events tab

1. Filter events by `VoteCommitted` → one entry from `0x7FA3…D21` with hash
   `0x3632…bab52` (commit tx `0xc96b…e3c24`, block 11777881).
2. Filter `VoteRevealed` → one entry: voter `0x7FA3…D21`, `candidateIndex` **0**
   (reveal tx `0x7b69…6896`, block 11777995).
3. Cross-check: revealed index 0 == Alice == the tally leader from §1.1.

### 1.3 Check eligibility wiring (optional)

`VoterRegistry` `0xBAD16caF2ab039a6373b341c484FcC2c19f2732a` → Read Contract →
`isEligible(0x7FA346a7E5bF8f5Ec3fA2752534352c91eA78D21)` → **true**.

---

## Tier 2 — RPC & CLI (technical)

Any Sepolia RPC endpoint works (Alchemy, Infura, public). No key needed for reads.
**Free-tier constraint:** Alchemy free allows `eth_getLogs` ranges of **10 blocks**
and throttles bursts (429) — always bound `fromBlock` near the election and expect
paging, never scan from block 0.

### 2.1 Tallies via `eth_call` (curl)

```bash
RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
VOTING=0xa2095f936A6cD1C31A35e1980dbE8D437AEDBE05
# getTotalVotes() selector = keccak("getTotalVotes()")[0:4] = 0x9a0e7d66
curl -s $RPC -X POST -H 'content-type: application/json' \
  --data "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$VOTING\",\"data\":\"0x9a0e7d66\"},\"latest\"]}"
# expect result 0x...01
```

### 2.2 Event logs via `eth_getLogs` (curl)

Topic hashes (canonical event signatures, computed with `ethers.id`):

```
VoteCommitted(address,bytes32)  topic0 0x378881b5d2d0f50f0782bfc28c9194fbce3515be77236885f5256babb2e45c33
VoteRevealed(address,uint256)   topic0 0x522b45c661375abb939dc17b4b600412c93af64fcbe24859a73539d01bb4eec8
```

```bash
# All D1 reveals in one 10-block window: reveal block is 11777995 (0xB3B7CB).
# Commit block 11777881 (0xB3B759) sits in the adjacent window 0xB3B754-0xB3B75D.
# Voter filter: append the 32-byte left-padded address as topics[1], e.g.
# 0x0000000000000000000000007fa346a7e5bf8f5ec3fa2752534352c91ea78d21
curl -s $RPC -X POST -H 'content-type: application/json' --data "{
  \"id\": 1, \"jsonrpc\": \"2.0\", \"method\": \"eth_getLogs\",
  \"params\": [{
    \"address\": \"$VOTING\", \"fromBlock\": \"0xB3B7C6\", \"toBlock\": \"0xB3B7CF\",
    \"topics\": [[
      \"0x378881b5d2d0f50f0782bfc28c9194fbce3515be77236885f5256babb2e45c33\",
      \"0x522b45c661375abb939dc17b4b600412c93af64fcbe24859a73539d01bb4eec8\"
    ]]
  }]
}"
```

If contracts are source-verified, the explorer decodes `data` fields automatically;
otherwise decode with the ABIs in `artifacts/contracts/Voting.sol/Voting.json`.

### 2.3 Offline tally script

Preferred form for known elections — receipt mode needs no block-range scan,
so free-tier log caps cannot bite:

```bash
node scripts/verifyTally.js --rpc $RPC --voting $VOTING \
  --tx 0x7b6988dfc4cfbe768cd14464241f0485d55f7beb89c2742fa966a894d016a896
# ok: true, counts [1,0,0], total 1, winner (0,1,false) — verified live on D1
```

Discovery form (reconstructs from a block window, paged serially with backoff):

```bash
node scripts/verifyTally.js --rpc $RPC --voting $VOTING --from-block 11777000
```

Provider source chain: `--rpc` flag → `SEPOLIA_URL` → `NEXT_PUBLIC_RPC_URL`.
The script pages logs in 10-block windows with backoff (same free-tier constraint
as §2.2), then asserts: every revealed index in range, no voter revealed twice,
reconstructed counts equal `getVotes(i)`, sum equals `getTotalVotes()`, and the
recomputed winner triple matches `getWinner()`. Exit 0 = verified. Its fixture
test (`test/verifyTally.test.js`) runs the same logic against an ephemeral
Hardhat election, guarding against ethers-v6 API drift.

---

## D3 Live Deployment (current, zero revealed votes)

- Factory `0x0F621760C56679d92E53D5ff13ba7802ccC1A08c`
- Voting `0xE3530F7DCE4d72Ad71D2f4D2A3EBE3eE205AA2A4`
- Registry `0x7663c7ac3063E52F7C3e7Ba410c26b72Cb97e588`

Useful only to confirm the read methods exist (`getName` → `General Election`,
tallies all zero). For tally verification, use D1 above.

## Historical D2 (superseded)

Factory `0xE2a9…` / voting `0x8382…` — superseded by D3, retained here so old links
resolve to a labeled deployment instead of a mystery address.
