/**
 * Local end-to-end: factory -> two elections (tie + clear winner),
 * full commit -> reveal -> winner cycle on the ephemeral Hardhat network.
 *
 * No secrets, no testnet, fully deterministic. Run: `make e2e-local`
 * Exit 0 on PASS, 1 on any assertion failure.
 */
async function main() {
  const [deployer, voter1, voter2, voter3] = await hre.ethers.getSigners();
  const E = hre.ethers;
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`E2E ASSERT: ${msg}`);
  };

  const COMMIT_DUR = 180;
  const REVEAL_DUR = 180;
  const CANDIDATES = ['Alice', 'Bob', 'Charlie'];

  const hashOf = (idx, salt) =>
    E.keccak256(E.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [idx, salt]));
  const increase = async (s) => {
    await hre.network.provider.send('evm_increaseTime', [s]);
    await hre.network.provider.send('evm_mine');
  };

  console.log('deployer:', deployer.address);

  const Factory = await E.getContractFactory('VotingFactory');
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  console.log('factory:', await factory.getAddress());

  async function createElection(name) {
    const tx = await factory.createElection(name, CANDIDATES, COMMIT_DUR, REVEAL_DUR, deployer.address);
    const receipt = await tx.wait();
    let votingAddr;
    let registryAddr;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === 'ElectionCreated') {
          votingAddr = parsed.args.voting;
          registryAddr = parsed.args.registry;
          break;
        }
      } catch {
        /* not our event */
      }
    }
    assert(votingAddr && registryAddr, `ElectionCreated not parsed for ${name}`);
    const Voting = await E.getContractFactory('Voting');
    const Registry = await E.getContractFactory('VoterRegistry');
    return {
      voting: Voting.attach(votingAddr),
      registry: Registry.attach(registryAddr),
      votingAddr,
      registryAddr,
    };
  }

  async function runElection(label, picks) {
    // picks: [{ voter, idx, saltString }]
    const e = await createElection(label);
    for (const p of picks) {
      await (await e.registry.addVoter(p.voter.address)).wait();
      assert(await e.registry.isEligible(p.voter.address), `not eligible: ${p.voter.address}`);
    }
    for (const p of picks) {
      const salt = E.id(p.saltString);
      await (await e.voting.connect(p.voter).commit(hashOf(p.idx, salt))).wait();
    }
    await increase(COMMIT_DUR + 5);
    for (const p of picks) {
      await (await e.voting.connect(p.voter).reveal(p.idx, E.id(p.saltString))).wait();
    }
    await increase(REVEAL_DUR + 5);
    return e;
  }

  // E1: three-way tie (0-1-2 x 1 vote each)
  const e1 = await runElection('E2E Tie', [
    { voter: voter1, idx: 0, saltString: 'e2e-s1' },
    { voter: voter2, idx: 1, saltString: 'e2e-s2' },
    { voter: voter3, idx: 2, saltString: 'e2e-s3' },
  ]);
  const [wIdx1, wVotes1, tied1] = await e1.voting.getWinner();
  const total1 = await e1.voting.getTotalVotes();
  console.log(`E1 tie -> idx=${wIdx1} votes=${wVotes1} tied=${tied1} total=${total1}`);
  assert(wVotes1 === 1n && tied1 === true && total1 === 3n, 'E1 tie mismatch');

  // E2: clear winner (Alice 2, Bob 1)
  const e2 = await runElection('E2E Winner', [
    { voter: voter1, idx: 0, saltString: 'e2e-t1' },
    { voter: voter2, idx: 0, saltString: 'e2e-t2' },
    { voter: voter3, idx: 1, saltString: 'e2e-t3' },
  ]);
  const [wIdx2, wVotes2, tied2] = await e2.voting.getWinner();
  const total2 = await e2.voting.getTotalVotes();
  console.log(`E2 winner -> idx=${wIdx2} votes=${wVotes2} tied=${tied2} total=${total2}`);
  assert(wIdx2 === 0n && wVotes2 === 2n && tied2 === false && total2 === 3n, 'E2 winner mismatch');

  // Factory enumeration via events (same path as the frontend selector)
  const events = await factory.queryFilter(factory.filters.ElectionCreated(), 0, 'latest');
  assert(events.length === 2, `expected 2 ElectionCreated events, got ${events.length}`);
  assert(events[0].args.voting === e1.votingAddr, 'E1 event voting mismatch');
  assert(events[1].args.voting === e2.votingAddr, 'E2 event voting mismatch');
  console.log('factory ElectionCreated events:', events.length);

  console.log('E2E PASS: tie + winner + factory enumeration verified');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('E2E FAIL:', e.message || e);
    process.exit(1);
  });
