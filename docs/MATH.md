# Mathematics — Commit-Reveal Voting, Verified Against Code & Tests

This document states the exact mathematical claims the system relies on, each tied
to the code that enforces it and the test that proves it. Nothing here is
aspirational: every vector below was produced by running the shipped code.

Notation: `K(x) = keccak256(x)`, `E(a, b) = abi.encode(uint256 a, bytes32 b)`.

## 1. Commitment Scheme

**Definitions** (mirrors `frontend/pages/index.js:buildVoteHash` and
`test/Voting.test.js:makeSalt/makeHash`):

```
salt  = K(bytes(userSecret))            (32 bytes)
commit(idx, salt) = K(E(idx, salt))     (32 bytes)
```

**Verified vectors** (ethers v6, reproduced by the `matches the documented
commitment math vectors` test):

```
salt("s1")       = 0x2217acd7ad0f4746f99625a00c7d8d3c7b2cffdf5118f5fc5faca80382fd852f
commit(0, salt)  = 0xffb6da29a872175afd05c5f44805e81ee108df01b6120099dc5e7f2f5abd751d
```

**Claim 1 (hiding).** During commit phase, `commit(idx, salt)` reveals nothing about
`idx` to observers without `salt`: keccak256 is preimage-resistant, and the stored
value is never compared until reveal. Enforced by: contract stores only the hash
(`Voting.commit`); no getter leaks `idx`. Tested by: every commit test asserts only
hash equality, never plaintext.

**Claim 2 (binding).** A committer cannot reveal a different index for the same
commitment: that requires `K(E(i,s)) = K(E(j,t))` with `(i,s) ≠ (j,t)`, i.e. a
keccak256 collision. Enforced by: `reveal` recomputes and compares
(`HashMismatch` otherwise). Tested by: `rejects reveal with wrong salt`.

**Claim 3 (domain separation).** `commit(i, s) ≠ commit(j, s)` for `i ≠ j`, and
`commit(i, s) ≠ commit(i, t)` for `s ≠ t`. Tested directly (inequality assertions).
`abi.encode` is used instead of `abi.encodePacked` as defense-in-depth: with two
fixed 32-byte words there is no padding ambiguity today, but `encode` keeps that
invariant structural rather than incidental.

**Operational caveat (honest).** Hiding assumes a high-entropy salt. Test salts like
`"s1"` and short user strings are brute-forceable offline. The frontend accepts any
non-empty salt and does not enforce entropy — treat short salts as test-only usage.

## 2. Phase Timing

Let `T0` = deployment timestamp, `Ct`/`Rt` the configured durations:

```
C = T0 + Ct        (commit deadline)
R = C + Rt         (reveal deadline)
commit valid  ⟺  block.timestamp < C
reveal valid  ⟺  C ≤ block.timestamp < R
```

The reveal window **includes** the exact boundary `t = C` (contract uses `<` for the
commit-side check and `< C` rejection on the reveal side), closing the former
one-second dead zone. Tested by: `rejects commit at exactly t == commitDeadline`
(`CommitPhaseOver`) and `allows reveal at exactly t == commitDeadline`
(`VoteRevealed` emitted). Default deployment: `Ct = Rt = 3600`.

## 3. Winner Rule

`getWinner()` scans N candidates, tracking `(maxVotes, firstIndexAtMax)`:

```
tied = true  ⟺  at least two candidates share the maximum AND maximum > 0
winnerIdx    = lowest index attaining the maximum (0 when no votes exist)
```

**Truth table** (each row is a passing test):

| Votes (A/B/C) | winnerIdx | winnerVotes | tied | Test |
|---|---|---|---|---|
| 0/0/0 | 0 | 0 | false | `returns no winner and no tie when there are zero votes` |
| 2/1/0 | 0 | 2 | false | `computes a clear winner via getWinner` |
| 1/1/0 | 0 | 1 | true | `flags a tie via getWinner` |
| 1/1/1 | 0 | 1 | true | `flags three-way tie` |
| 2/1/0 (3 voters, Alice×2) | 0 | 2 | false | `flags three-way tie with Alice winning` |
| 2/2/1 | 0 | 2 | true | `flags a 2-2-1 partial tie with the lowest index winning` |

The `v > 0` guard is what keeps the all-zero case untied; the strict `>` (not `>=`)
on new maxima is what keeps `winnerIdx` at the lowest tied index.

## 4. Conservation Invariants

- **Vote conservation:** `getTotalVotes() == Σ getVotes(i)`, tested by
  `conserves votes: total equals the sum of tallies` (3 = 1 + 0 + 2).
- **One vote per address:** `hasCommitted` gates `commit` (`AlreadyCommitted`);
  `hasVoted` gates both `commit` and `reveal` (`AlreadyVoted`); the stored
  commitment is deleted on reveal, and `getCommit` returns `ZeroHash` afterwards
  (tested in `tracks commit lifecycle flags and clears the stored hash on reveal`).
- **Per-voter scoping (anti-griefing):** commitments live in
  `mapping(address => bytes32)`, so two voters sharing the same `(idx, salt)`
  commit and reveal independently — tested by
  `does not collide when two voters use the same (idx, salt)` (tally reaches 2).

## 5. Registry Semantics (mathematical triviality, stated for completeness)

Eligibility is a boolean map with owner-only writes. `removeVoter` is a **soft
clear**: it sets `false` and emits `VoterRemoved` even for never-eligible addresses
(tested explicitly). Re-adding after removal restores eligibility. Whitelists are
per-election (factory pairs are independent — tested by cross-election assertions).

## 6. How to Re-verify

```bash
make compile && make test        # 50 contract tests incl. vectors + truth table
make test-backend                # 19 API tests
make e2e-local                   # tie + winner + event enumeration, deterministic
```

Any change to `Voting.sol` hashing, phase comparisons, or `getWinner` logic must
update the vectors/table above first — the tests encode them as constants.
