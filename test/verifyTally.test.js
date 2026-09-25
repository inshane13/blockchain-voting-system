import { expect } from 'chai';
import hre from 'hardhat';
import { verifyTally } from '../scripts/verifyTally.js';

const { ethers } = hre;

// Fixture test for the offline tally verifier: runs a real election on the
// ephemeral network, then asserts verifyTally() reconstructs it exactly.
// Guards against ethers-v6 API drift silently breaking the runbook script.
describe('verifyTally fixture', function () {
  function makeSalt(str) {
    return ethers.keccak256(ethers.toUtf8Bytes(str));
  }

  function makeHash(idx, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [idx, salt])
    );
  }

  async function increaseTime(seconds) {
    await ethers.provider.send('evm_increaseTime', [seconds]);
    await ethers.provider.send('evm_mine');
  }

  it('reconstructs a 2-1 tally with tie=false from event logs', async function () {
    const [owner, voter1, voter2, voter3] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory('VotingFactory');
    const factory = await Factory.deploy(owner.address);
    await factory.waitForDeployment();

    const fromBlock = await ethers.provider.getBlockNumber();
    const tx = await factory.createElection(
      'Verify Fixture',
      ['Alice', 'Bob', 'Charlie'],
      3600,
      3600,
      owner.address
    );
    const receipt = await tx.wait();
    let votingAddress;
    let registryAddress;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === 'ElectionCreated') {
          votingAddress = parsed.args.voting;
          registryAddress = parsed.args.registry;
          break;
        }
      } catch {
        /* not our event */
      }
    }
    expect(votingAddress).to.be.properAddress;

    const Voting = await ethers.getContractFactory('Voting');
    const VoterRegistry = await ethers.getContractFactory('VoterRegistry');
    const voting = Voting.attach(votingAddress);
    const registry = VoterRegistry.attach(registryAddress);
    for (const v of [voter1, voter2, voter3]) {
      await registry.addVoter(v.address);
    }

    const salts = [makeSalt('v1'), makeSalt('v2'), makeSalt('v3')];
    const picks = [0, 0, 1];
    const voters = [voter1, voter2, voter3];
    for (let i = 0; i < 3; i++) {
      await voting.connect(voters[i]).commit(makeHash(picks[i], salts[i]));
    }
    await increaseTime(3601);
    for (let i = 0; i < 3; i++) {
      await voting.connect(voters[i]).reveal(picks[i], salts[i]);
    }

    const report = await verifyTally(ethers.provider, votingAddress, fromBlock);
    expect(report.candidateCount).to.equal(3);
    expect(report.revealEvents).to.equal(3);
    expect(report.uniqueVoters).to.equal(3);
    expect(report.counts).to.deep.equal([2, 1, 0]);
    expect(report.total).to.equal(3);
    expect(report.winner).to.deep.equal({ idx: 0, votes: 2, tied: false });
    expect(report.checks).to.have.lengthOf(3);
  });

  it('rejects a tampered reconstruction (wrong address input)', async function () {
    await expect(
      verifyTally(ethers.provider, 'not-an-address', 0)
    ).to.be.rejectedWith(/invalid voting address/i);
  });
});
