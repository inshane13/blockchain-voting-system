/**
 * Offline tally verifier — independently reconstructs an election tally from
 * on-chain `VoteRevealed` logs and asserts it matches contract state.
 *
 * What it proves: every revealed index is in range, no voter revealed twice,
 * and reconstructed per-candidate counts exactly equal `getVotes(i)`,
 * `getTotalVotes()`, and `getWinner()`.
 *
 * What it does NOT prove: that hidden commits correspond to reveals (salts stay
 * secret by design) — see docs/MATH.md binding argument for that half.
 *
 * Library + CLI in one file (ESM, no new deps — ethers only):
 *   node scripts/verifyTally.js --rpc <url> --voting <0x...> [--from-block <n|0x..>]
 *   node scripts/verifyTally.js --rpc <url> --voting <0x...> --tx <hash>[,<hash>...]
 * RPC fallback chain: --rpc > SEPOLIA_URL > NEXT_PUBLIC_RPC_URL
 * --tx mode fetches receipts directly (no block-range scan), so it works for
 * historical elections whose events aged out of free-tier log windows.
 */
import { ethers } from 'ethers';
import { fileURLToPath } from 'url';

const VOTING_MIN_ABI = [
  'function getCandidatesCount() view returns (uint256)',
  'function getVotes(uint256) view returns (uint256)',
  'function getTotalVotes() view returns (uint256)',
  'function getWinner() view returns (uint256 winnerIdx, uint256 winnerVotes, bool tied)',
  'event VoteRevealed(address indexed voter, uint256 indexed candidateIndex)',
];

/**
 * Shared reconstruction core: takes parsed reveal entries
 * [{ voter, idx, tx, block }] and asserts them against contract state.
 */
async function reconstructAndAssert(voting, votingAddress, entries, candidateCount) {
  const counts = new Array(candidateCount).fill(0);
  const seenVoters = new Set();
  const checks = [];
  for (const e of entries) {
    const voter = e.voter.toLowerCase();
    const idx = Number(e.idx);
    checks.push({ voter, idx, tx: e.tx, block: e.block });
    if (idx < 0 || idx >= candidateCount) {
      throw new Error(`verifyTally: out-of-range index ${idx} in ${e.tx}`);
    }
    if (seenVoters.has(voter)) {
      throw new Error(`verifyTally: double reveal by ${voter}`);
    }
    seenVoters.add(voter);
    counts[idx] += 1;
  }

  for (let i = 0; i < candidateCount; i++) {
    const onChain = Number(await voting.getVotes(i));
    if (onChain !== counts[i]) {
      throw new Error(`verifyTally: candidate ${i} reconstructed=${counts[i]} onChain=${onChain}`);
    }
  }
  const total = Number(await voting.getTotalVotes());
  const reconstructedTotal = counts.reduce((a, b) => a + b, 0);
  if (total !== reconstructedTotal) {
    throw new Error(`verifyTally: total reconstructed=${reconstructedTotal} onChain=${total}`);
  }
  const [winnerIdx, winnerVotes, tied] = await voting.getWinner();
  const maxVotes = Math.max(...counts);
  const leaders = counts.map((v, i) => (v === maxVotes ? i : -1)).filter((i) => i >= 0);
  const expectedTied = leaders.length > 1 && maxVotes > 0;
  const expectedIdx = maxVotes === 0 ? 0 : leaders[0];
  if (Number(winnerIdx) !== expectedIdx || Number(winnerVotes) !== maxVotes || tied !== expectedTied) {
    throw new Error(
      `verifyTally: winner mismatch onChain=(${winnerIdx},${winnerVotes},${tied}) ` +
        `expected=(${expectedIdx},${maxVotes},${expectedTied})`
    );
  }

  return {
    votingAddress,
    candidateCount,
    revealEvents: entries.length,
    uniqueVoters: seenVoters.size,
    counts,
    total,
    winner: { idx: Number(winnerIdx), votes: Number(winnerVotes), tied },
    checks,
  };
}

function checkVotingAddress(votingAddress) {
  if (!ethers.isAddress(votingAddress)) {
    throw new Error(`verifyTally: invalid voting address ${votingAddress}`);
  }
}

export async function verifyTally(provider, votingAddress, fromBlock = 0) {
  checkVotingAddress(votingAddress);
  const voting = new ethers.Contract(votingAddress, VOTING_MIN_ABI, provider);
  const candidateCount = Number(await voting.getCandidatesCount());
  const filter = voting.filters.VoteRevealed();
  // Free-tier RPCs cap eth_getLogs ranges (Alchemy free: 10 blocks). Page forward
  // in 10-block chunks (8-way parallel), capped at ~5000 blocks of history.
  const PAGE = 10;
  const MAX_SPAN = 5000;
  const latest = await provider.getBlockNumber();
  const start = Math.max(Number(fromBlock) || 0, latest - MAX_SPAN);
  if (latest - start >= MAX_SPAN && Number(fromBlock) < latest - MAX_SPAN) {
    console.error(
      `verifyTally note: history capped to the last ${MAX_SPAN} blocks; ` +
        `pass --from-block near the election to cover older deployments.`
    );
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function queryPage(f, t) {
    // Serial requests + backoff: free-tier plans throttle compute units/second,
    // so parallel bursts return 429 (observed live on Sepolia/Alchemy).
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await voting.queryFilter(filter, f, t);
      } catch (e) {
        lastErr = e;
        await sleep(400 * 2 ** attempt);
      }
    }
    throw lastErr;
  }
  const logs = [];
  for (let f = start; f <= latest; f += PAGE) {
    const page = await queryPage(f, Math.min(f + PAGE - 1, latest));
    logs.push(...page);
  }

  const entries = logs.map((log) => ({
    voter: log.args.voter,
    idx: log.args.candidateIndex,
    tx: log.transactionHash,
    block: log.blockNumber,
  }));
  return reconstructAndAssert(voting, votingAddress, entries, candidateCount);
}

/**
 * Receipt mode: reconstruct from explicit transaction hashes instead of a block
 * range. Immune to RPC log-depth caps — the fix for historical elections whose
 * events have aged out of fetchable windows. CLI: --tx <hash>[,<hash>...].
 */
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export async function verifyTallyByTx(provider, votingAddress, txHashes) {
  checkVotingAddress(votingAddress);
  if (!Array.isArray(txHashes) || txHashes.length === 0) {
    throw new Error('verifyTally: --tx requires at least one transaction hash');
  }
  for (const h of txHashes) {
    if (typeof h !== 'string' || !TX_HASH_RE.test(h.trim())) {
      throw new Error(`verifyTally: invalid transaction hash ${h}`);
    }
  }
  const voting = new ethers.Contract(votingAddress, VOTING_MIN_ABI, provider);
  const candidateCount = Number(await voting.getCandidatesCount());
  const entries = [];
  for (const raw of txHashes) {
    const h = raw.trim();
    const receipt = await provider.getTransactionReceipt(h);
    if (!receipt) {
      throw new Error(`verifyTally: receipt not found for ${h}`);
    }
    if (receipt.status !== 1 && receipt.status !== 1n) {
      throw new Error(`verifyTally: transaction reverted ${h}`);
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== votingAddress.toLowerCase()) continue;
      let parsed = null;
      try {
        parsed = voting.interface.parseLog(log);
      } catch {
        continue; // not a Voting event (e.g. registry calls in the same tx)
      }
      if (parsed && parsed.name === 'VoteRevealed') {
        entries.push({
          voter: parsed.args.voter,
          idx: parsed.args.candidateIndex,
          tx: h,
          block: log.blockNumber,
        });
      }
    }
  }
  if (entries.length === 0) {
    throw new Error('verifyTally: no VoteRevealed events found in the given transactions');
  }
  return reconstructAndAssert(voting, votingAddress, entries, candidateCount);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rpc') out.rpc = argv[++i];
    else if (argv[i] === '--voting') out.voting = argv[++i];
    else if (argv[i] === '--tx') out.tx = argv[++i];
    else if (argv[i] === '--from-block') {
      const v = argv[++i];
      out.fromBlock = v.startsWith('0x') ? parseInt(v, 16) : Number(v);
    }
  }
  out.rpc = out.rpc || process.env.SEPOLIA_URL || process.env.NEXT_PUBLIC_RPC_URL;
  out.fromBlock = out.fromBlock ?? 0;
  return out;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const { rpc, voting, tx, fromBlock } = parseArgs(process.argv.slice(2));
  if (!rpc || !voting) {
    console.error(
      'Usage:\n' +
        '  node scripts/verifyTally.js --rpc <url> --voting <0x...> [--from-block <n>]\n' +
        '  node scripts/verifyTally.js --rpc <url> --voting <0x...> --tx <hash>[,<hash>...]'
    );
    process.exit(2);
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const job = tx
    ? verifyTallyByTx(provider, voting, tx.split(','))
    : verifyTally(provider, voting, fromBlock);
  job
    .then((report) => {
      console.log(JSON.stringify({ ok: true, ...report, checks: report.checks.length }, null, 2));
    })
    .catch((e) => {
      console.error(`verifyTally FAIL: ${e.message}`);
      process.exit(1);
    });
}
