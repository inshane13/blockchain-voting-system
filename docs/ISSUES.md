# Filed Follow-Up Issues

Single-issue records too small for a tracker ticket but too important to lose.
Each entry: problem, fix shape, acceptance. Close by deleting the section.

## CLOSED (2.4.0, `ec58e81`) — `verifyTally.js`: tx-hash receipt mode
Shipped as `--tx <hash>[,…]` with fixture tests; proven live on D1. Paged scan
retained as the discovery path.

## OPEN — `verifyTally.js`: tx-hash receipt mode (log-depth decay)

**Problem.** Tier 2 verification reconstructs tallies from `VoteRevealed` event
logs, but free-tier RPCs cap `eth_getLogs` at ~10-block ranges, so the script
pages serially (~300 blocks max). As Sepolia advances, historical elections
(e.g. D1) slide out of the fetchable window: Tier 1 state reads keep working
while Tier 2 reconstruction fails. Same root cause as the frontend ~300-block
dropdown cap.
**Fix shape.** Accept `--tx <hash>[,…]` alongside `--from-block`: fetch each via
`eth_getTransactionReceipt` (no block range involved), parse `VoteRevealed`
logs, run the identical assertion set. Keep paged scan as the discovery path.
**Acceptance.** Fixture test covers receipt mode (receipt-shaped stub or
targeted-range ephemeral election); `docs/VERIFY.md` Tier 2 documents both
modes; D1 re-verified through the new path.
