# Limitations Abstract — Commit-Reveal Voting Integrity Prototype

This system implements commit-reveal voting on Ethereum: on-chain voter
eligibility (`VoterRegistry`), tamper-evident vote recording with hiding-plus-
binding commitments (`keccak256(abi.encode(candidateIndex, salt))`), publicly
readable tallies (`getVotes` / `getWinner` / `getTotalVotes`), and isolated
per-election deployments via `VotingFactory`. The implementation is measured,
not asserted: 50 contract tests plus 19 backend tests green, receipt-captured
gas of 154,687 per voter (78,792 commit + 75,895 reveal, reproduced exactly on
Sepolia), and an observer runbook that re-verifies a live tally without a wallet.

What it does not provide: no privacy-enhancing cryptography (no ZK proofs,
homomorphic tallying, ring or blind signatures), hence no voter anonymity
post-reveal; no coercion resistance or receipt-freeness (the browser-stored
salt is a transferable voting receipt); no universal verifiability beyond the
public tally; and no national-scale throughput (945M voters would require
~677 days at 100% of Ethereum L1 block space — see `docs/BENCHMARKS.md`).

Consequence for deployment scope: suitable for municipal, enterprise, and
DAO-governance elections, and as an empirical baseline for voting-systems
research. National-scale, anonymity-preserving, or legally binding elections
require L2 execution plus PET protocol work — classified here, following Manda
& Bhukya (2024), as future research, not as defects of this prototype.
