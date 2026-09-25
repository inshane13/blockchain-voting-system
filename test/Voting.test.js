import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const CANDIDATES = ["Alice", "Bob", "Charlie"];
const COMMIT_TIME = 3600;
const REVEAL_TIME = 3600;

function makeSalt(str) {
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

function makeHash(idx, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [idx, salt])
  );
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

async function setNextTimestamp(ts) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
  await ethers.provider.send("evm_mine");
}

async function deployFixture() {
  const [owner, addr1, addr2, addr3] = await ethers.getSigners();

  const VoterRegistry = await ethers.getContractFactory("VoterRegistry");
  const registry = await VoterRegistry.deploy(owner.address);
  await registry.waitForDeployment();

  for (const a of [addr1, addr2, addr3]) {
    await registry.addVoter(a.address);
  }

  const Voting = await ethers.getContractFactory("Voting");
  const voting = await Voting.deploy(
    "Test Election",
    CANDIDATES,
    COMMIT_TIME,
    REVEAL_TIME,
    await registry.getAddress()
  );
  await voting.waitForDeployment();

  return { registry, voting, owner, addr1, addr2, addr3 };
}

describe("Voting", function () {
  it("deploys with correct parameters", async function () {
    const { voting } = await deployFixture();
    expect(await voting.getName()).to.equal("Test Election");
    expect(await voting.getCandidates()).to.deep.equal(CANDIDATES);
    expect(await voting.getCandidatesCount()).to.equal(3);
  });

  it("reverts constructor with zero registry address", async function () {
    const Voting = await ethers.getContractFactory("Voting");
    await expect(
      Voting.deploy("X", CANDIDATES, COMMIT_TIME, REVEAL_TIME, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(Voting, "InvalidRegistry");
  });

  it("reverts constructor with no candidates", async function () {
    const { registry } = await deployFixture();
    const Voting = await ethers.getContractFactory("Voting");
    await expect(
      Voting.deploy("X", [], COMMIT_TIME, REVEAL_TIME, await registry.getAddress())
    ).to.be.revertedWithCustomError(Voting, "NoCandidates");
  });

  it("reverts constructor with invalid durations", async function () {
    const { registry } = await deployFixture();
    const Voting = await ethers.getContractFactory("Voting");
    const registryAddress = await registry.getAddress();
    await expect(
      Voting.deploy("X", CANDIDATES, 0, REVEAL_TIME, registryAddress)
    ).to.be.revertedWithCustomError(Voting, "InvalidDurations");
    await expect(
      Voting.deploy("X", CANDIDATES, COMMIT_TIME, 0, registryAddress)
    ).to.be.revertedWithCustomError(Voting, "InvalidDurations");
  });

  it("allows commit during commit phase and emits VoteCommitted", async function () {
    const { voting, addr1 } = await deployFixture();
    const hash = makeHash(0, makeSalt("s1"));
    await expect(voting.connect(addr1).commit(hash))
      .to.emit(voting, "VoteCommitted")
      .withArgs(addr1.address, hash);
    expect(await voting.hasCommitted(addr1.address)).to.equal(true);
    expect(await voting.getCommit(addr1.address)).to.equal(hash);
  });

  it("rejects commit after the commit deadline", async function () {
    const { voting, addr1 } = await deployFixture();
    await increaseTime(COMMIT_TIME + 1);
    await expect(voting.connect(addr1).commit(makeHash(0, makeSalt("s1")))).to.be.revertedWithCustomError(
      voting,
      "CommitPhaseOver"
    );
  });

  it("rejects commit at exactly t == commitDeadline", async function () {
    const { voting, addr1 } = await deployFixture();
    const deadline = await voting.getCommitDeadline();
    await setNextTimestamp(Number(deadline));
    await expect(voting.connect(addr1).commit(makeHash(0, makeSalt("s1")))).to.be.revertedWithCustomError(
      voting,
      "CommitPhaseOver"
    );
  });

  it("allows reveal at exactly t == commitDeadline (dead-zone closed)", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    const deadline = await voting.getCommitDeadline();
    await setNextTimestamp(Number(deadline));
    await expect(voting.connect(addr1).reveal(0, salt))
      .to.emit(voting, "VoteRevealed")
      .withArgs(addr1.address, 0);
  });

  it("increments tally on valid reveal", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    await increaseTime(COMMIT_TIME + 1);
    await voting.connect(addr1).reveal(0, salt);
    expect(await voting.getVotes(0)).to.equal(1);
    expect(await voting.getTotalVotes()).to.equal(1);
  });

  it("rejects a second reveal from the same voter", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    await increaseTime(COMMIT_TIME + 1);
    await voting.connect(addr1).reveal(0, salt);
    await expect(voting.connect(addr1).reveal(1, salt)).to.be.revertedWithCustomError(
      voting,
      "AlreadyVoted"
    );
  });

  it("rejects invalid candidate index on reveal", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    await increaseTime(COMMIT_TIME + 1);
    await expect(voting.connect(addr1).reveal(5, salt)).to.be.revertedWithCustomError(
      voting,
      "InvalidCandidate"
    );
  });

  it("rejects commit from non-eligible voter", async function () {
    const { registry, voting, addr1 } = await deployFixture();
    await registry.removeVoter(addr1.address);
    await expect(voting.connect(addr1).commit(makeHash(0, makeSalt("s1")))).to.be.revertedWithCustomError(
      voting,
      "NotEligible"
    );
  });

  it("rejects double commit", async function () {
    const { voting, addr1 } = await deployFixture();
    await voting.connect(addr1).commit(makeHash(0, makeSalt("s1")));
    await expect(voting.connect(addr1).commit(makeHash(1, makeSalt("s1")))).to.be.revertedWithCustomError(
      voting,
      "AlreadyCommitted"
    );
  });

  it("rejects reveal with wrong salt", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    await increaseTime(COMMIT_TIME + 1);
    await expect(voting.connect(addr1).reveal(0, makeSalt("wrong"))).to.be.revertedWithCustomError(
      voting,
      "HashMismatch"
    );
  });

  it("rejects reveal without a prior commit", async function () {
    const { voting, addr1 } = await deployFixture();
    await increaseTime(COMMIT_TIME + 1);
    await expect(voting.connect(addr1).reveal(0, makeSalt("s1"))).to.be.revertedWithCustomError(
      voting,
      "HashMismatch"
    );
  });

  it("rejects reveal after the reveal deadline", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("s1");
    await voting.connect(addr1).commit(makeHash(0, salt));
    await increaseTime(COMMIT_TIME + REVEAL_TIME + 1);
    await expect(voting.connect(addr1).reveal(0, salt)).to.be.revertedWithCustomError(
      voting,
      "RevealPhaseOver"
    );
  });

  it("rejects a zero commit hash", async function () {
    const { voting, addr1 } = await deployFixture();
    await expect(voting.connect(addr1).commit(ethers.ZeroHash)).to.be.revertedWithCustomError(
      voting,
      "InvalidHash"
    );
  });

  it("does not collide when two voters use the same (idx, salt)", async function () {
    const { voting, addr1, addr2 } = await deployFixture();
    const salt = makeSalt("shared_secret");
    const hash = makeHash(0, salt);

    await voting.connect(addr1).commit(hash);
    await voting.connect(addr2).commit(hash);
    await increaseTime(COMMIT_TIME + 1);

    await expect(voting.connect(addr1).reveal(0, salt)).to.emit(voting, "VoteRevealed");
    await expect(voting.connect(addr2).reveal(0, salt)).to.emit(voting, "VoteRevealed");
    expect(await voting.getVotes(0)).to.equal(2);
  });

  it("computes a clear winner via getWinner", async function () {
    const { voting, addr1, addr2, addr3 } = await deployFixture();
    const s1 = makeSalt("s1");
    const s2 = makeSalt("s2");
    const s3 = makeSalt("s3");

    await voting.connect(addr1).commit(makeHash(0, s1));
    await voting.connect(addr2).commit(makeHash(0, s2));
    await voting.connect(addr3).commit(makeHash(1, s3));
    await increaseTime(COMMIT_TIME + 1);

    await voting.connect(addr1).reveal(0, s1);
    await voting.connect(addr2).reveal(0, s2);
    await voting.connect(addr3).reveal(1, s3);

    const [winnerIdx, winnerVotes, tied] = await voting.getWinner();
    expect(winnerIdx).to.equal(0);
    expect(winnerVotes).to.equal(2);
    expect(tied).to.equal(false);
    expect(await voting.getTotalVotes()).to.equal(3);
  });

  

  it("flags three-way tie", async function () {
    const [, voter1, voter2, voter3] = await hre.ethers.getSigners();
    const { voting, registry } = await deployFixture();
    
    // voters addr1, addr2, addr3 are already registered by deployFixture
    const salt1 = hre.ethers.id("s1");
    const salt2 = hre.ethers.id("s2");
    const salt3 = hre.ethers.id("s3");

    const hash1 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"],
        [0, salt1]
      )
    );
    const hash2 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"],
        [1, salt2]
      )
    );
    const hash3 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"],
        [2, salt3]
      )
    );

    await voting.connect(voter1).commit(hash1);
    await voting.connect(voter2).commit(hash2);
    await voting.connect(voter3).commit(hash3);

    await hre.network.provider.send("evm_increaseTime", [3600]);
    await hre.network.provider.send("evm_mine");

    await voting.connect(voter1).reveal(0, salt1);
    await voting.connect(voter2).reveal(1, salt2);
    await voting.connect(voter3).reveal(2, salt3);

    await hre.network.provider.send("evm_increaseTime", [3600]);
    await hre.network.provider.send("evm_mine");

    const [, votes, isTie] = await voting.getWinner();
    expect(votes).to.equal(1n);
    expect(isTie).to.equal(true);
    expect(await voting.getTotalVotes()).to.equal(3n);
  })

  it("flags three-way tie with Alice winning", async function () {
    const [, voter1, voter2, voter3] = await hre.ethers.getSigners();
    const { voting, registry } = await deployFixture();
    
    const salt1 = hre.ethers.id("s1");
    const salt2 = hre.ethers.id("s2");
    const salt3 = hre.ethers.id("s3");

    const hash1 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"], [0, salt1]
      )
    );
    const hash2 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"], [1, salt2]
      )
    );
    const hash3 = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32"], [0, salt3]
      )
    );

    await voting.connect(voter1).commit(hash1);
    await voting.connect(voter2).commit(hash2);
    await voting.connect(voter3).commit(hash3);

    await hre.network.provider.send("evm_increaseTime", [3600]);
    await hre.network.provider.send("evm_mine");

    await voting.connect(voter1).reveal(0, salt1);
    await voting.connect(voter2).reveal(1, salt2);
    await voting.connect(voter3).reveal(0, salt3);

    await hre.network.provider.send("evm_increaseTime", [3600]);
    await hre.network.provider.send("evm_mine");

    const [winner, votes, isTie] = await voting.getWinner();
    expect(winner).to.equal(0);
    expect(votes).to.equal(2n);
    expect(isTie).to.equal(false);
    expect(await voting.getTotalVotes()).to.equal(3n);
  });;it("flags a tie via getWinner", async function () {
    const { voting, addr1, addr2 } = await deployFixture();
    const s1 = makeSalt("s1");
    const s2 = makeSalt("s2");

    await voting.connect(addr1).commit(makeHash(0, s1));
    await voting.connect(addr2).commit(makeHash(1, s2));
    await increaseTime(COMMIT_TIME + 1);

    await voting.connect(addr1).reveal(0, s1);
    await voting.connect(addr2).reveal(1, s2);

    const [, winnerVotes, tied] = await voting.getWinner();
    expect(winnerVotes).to.equal(1);
    expect(tied).to.equal(true);
  });

  it("returns no winner and no tie when there are zero votes", async function () {
    const { voting } = await deployFixture();
    const [winnerIdx, winnerVotes, tied] = await voting.getWinner();
    expect(winnerIdx).to.equal(0);
    expect(winnerVotes).to.equal(0);
    expect(tied).to.equal(false);
    expect(await voting.getTotalVotes()).to.equal(0);
  });
});

describe("VoterRegistry", function () {
  it("adds a voter and emits VoterAdded", async function () {
    const { registry, addr1 } = await deployFixture();
    // addr1 already registered in fixture; use a fresh signer
    const [, , , , fresh] = await ethers.getSigners();
    await expect(registry.addVoter(fresh.address))
      .to.emit(registry, "VoterAdded")
      .withArgs(fresh.address);
    expect(await registry.isEligible(fresh.address)).to.equal(true);
  });

  it("rejects adding the same voter twice", async function () {
    const { registry, addr1 } = await deployFixture();
    await expect(registry.addVoter(addr1.address)).to.be.revertedWithCustomError(
      registry,
      "AlreadyEligible"
    );
  });

  it("removes a voter and emits VoterRemoved", async function () {
    const { registry, addr1 } = await deployFixture();
    await expect(registry.removeVoter(addr1.address))
      .to.emit(registry, "VoterRemoved")
      .withArgs(addr1.address);
    expect(await registry.isEligible(addr1.address)).to.equal(false);
  });

  it("rejects the zero address", async function () {
    const { registry } = await deployFixture();
    await expect(registry.addVoter(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      registry,
      "InvalidAddress"
    );
  });

  it("only allows the owner to add voters", async function () {
    const { registry, addr1 } = await deployFixture();
    const [, , , , fresh] = await ethers.getSigners();
    await expect(registry.connect(addr1).addVoter(fresh.address)).to.be.reverted;
  });

  it("only allows the owner to remove voters", async function () {
    const { registry, addr1 } = await deployFixture();
    await expect(registry.connect(addr1).removeVoter(addr1.address)).to.be.reverted;
  });

  it("removeVoter on a never-eligible address is a soft clear (emits, stays false)", async function () {
    const { registry } = await deployFixture();
    const [, , , , fresh] = await ethers.getSigners();
    expect(await registry.isEligible(fresh.address)).to.equal(false);
    await expect(registry.removeVoter(fresh.address))
      .to.emit(registry, "VoterRemoved")
      .withArgs(fresh.address);
    expect(await registry.isEligible(fresh.address)).to.equal(false);
  });

  it("re-adds a voter after removal", async function () {
    const { registry, addr1 } = await deployFixture();
    await registry.removeVoter(addr1.address);
    expect(await registry.isEligible(addr1.address)).to.equal(false);
    await expect(registry.addVoter(addr1.address))
      .to.emit(registry, "VoterAdded")
      .withArgs(addr1.address);
    expect(await registry.isEligible(addr1.address)).to.equal(true);
  });

  it("removeVoter rejects the zero address", async function () {
    const { registry } = await deployFixture();
    await expect(registry.removeVoter(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      registry,
      "InvalidAddress"
    );
  });

  it("owner is the deployer", async function () {
    const { registry, owner } = await deployFixture();
    expect(await registry.owner()).to.equal(owner.address);
  });
});

describe("Voting - getters, math and edge cases", function () {
  it("orders deadlines as deployTime < commit < reveal", async function () {
    const { voting } = await deployFixture();
    const commitDl = await voting.getCommitDeadline();
    const revealDl = await voting.getRevealDeadline();
    expect(revealDl - commitDl).to.equal(BigInt(REVEAL_TIME));
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(commitDl).to.be.gt(now - 3600n); // deployed recently
    expect(revealDl).to.be.gt(commitDl);
  });

  it("getVotes out of bounds returns 0 instead of reverting", async function () {
    const { voting } = await deployFixture();
    expect(await voting.getVotes(999)).to.equal(0);
  });

  it("tracks commit lifecycle flags and clears the stored hash on reveal", async function () {
    const { voting, addr1 } = await deployFixture();
    expect(await voting.hasCommitted(addr1.address)).to.equal(false);
    expect(await voting.hasVoted(addr1.address)).to.equal(false);
    const salt = makeSalt("s1");
    const hash = makeHash(0, salt);
    await voting.connect(addr1).commit(hash);
    expect(await voting.hasCommitted(addr1.address)).to.equal(true);
    expect(await voting.hasVoted(addr1.address)).to.equal(false);
    expect(await voting.getCommit(addr1.address)).to.equal(hash);
    await increaseTime(COMMIT_TIME + 1);
    await voting.connect(addr1).reveal(0, salt);
    expect(await voting.hasVoted(addr1.address)).to.equal(true);
    expect(await voting.getCommit(addr1.address)).to.equal(ethers.ZeroHash);
  });

  it("matches the documented commitment math vectors", async function () {
    // salt = keccak256(bytes("s1")); H = keccak256(abi.encode(0, salt)).
    // Vectors generated offline with ethers v6; see docs/MATH.md.
    expect(makeSalt("s1")).to.equal(
      "0x2217acd7ad0f4746f99625a00c7d8d3c7b2cffdf5118f5fc5faca80382fd852f"
    );
    expect(makeHash(0, makeSalt("s1"))).to.equal(
      "0xffb6da29a872175afd05c5f44805e81ee108df01b6120099dc5e7f2f5abd751d"
    );
    // Different salts for the same index must give different commitments.
    expect(makeHash(0, makeSalt("s1"))).to.not.equal(makeHash(0, makeSalt("s2")));
    // Different indices for the same salt must give different commitments.
    expect(makeHash(0, makeSalt("s1"))).to.not.equal(makeHash(1, makeSalt("s1")));
  });

  it("flags a 2-2-1 partial tie with the lowest index winning", async function () {
    const { voting, registry, owner } = await deployFixture();
    const [, a, b, c, d, e] = await ethers.getSigners();
    for (const v of [d, e]) {
      await registry.connect(owner).addVoter(v.address);
    }
    const salts = [makeSalt("t1"), makeSalt("t2"), makeSalt("t3"), makeSalt("t4"), makeSalt("t5")];
    const voters = [a, b, c, d, e];
    const picks = [0, 1, 0, 1, 2]; // Alice 2, Bob 2, Charlie 1
    for (let i = 0; i < 5; i++) {
      await voting.connect(voters[i]).commit(makeHash(picks[i], salts[i]));
    }
    await increaseTime(COMMIT_TIME + 1);
    for (let i = 0; i < 5; i++) {
      await voting.connect(voters[i]).reveal(picks[i], salts[i]);
    }
    const [winnerIdx, winnerVotes, tied] = await voting.getWinner();
    expect(winnerIdx).to.equal(0);
    expect(winnerVotes).to.equal(2);
    expect(tied).to.equal(true);
    expect(await voting.getTotalVotes()).to.equal(5);
  });

  it("conserves votes: total equals the sum of tallies", async function () {
    const { voting, addr1, addr2, addr3 } = await deployFixture();
    const s = [makeSalt("c1"), makeSalt("c2"), makeSalt("c3")];
    await voting.connect(addr1).commit(makeHash(2, s[0]));
    await voting.connect(addr2).commit(makeHash(2, s[1]));
    await voting.connect(addr3).commit(makeHash(0, s[2]));
    await increaseTime(COMMIT_TIME + 1);
    await voting.connect(addr1).reveal(2, s[0]);
    await voting.connect(addr2).reveal(2, s[1]);
    await voting.connect(addr3).reveal(0, s[2]);
    const sum =
      (await voting.getVotes(0)) + (await voting.getVotes(1)) + (await voting.getVotes(2));
    expect(await voting.getTotalVotes()).to.equal(sum);
    expect(sum).to.equal(3);
  });

  it("rejects reveal in the commit window even with a correct preimage", async function () {
    const { voting, addr1 } = await deployFixture();
    const salt = makeSalt("early");
    await voting.connect(addr1).commit(makeHash(1, salt));
    await expect(voting.connect(addr1).reveal(1, salt)).to.be.revertedWithCustomError(
      voting,
      "CommitPhaseActive"
    );
  });
});

describe("VotingFactory", function () {
  async function deployFactoryFixture() {
    const [owner, admin, outsider] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("VotingFactory");
    const factory = await Factory.deploy(owner.address);
    await factory.waitForDeployment();
    return { factory, owner, admin, outsider };
  }

  async function createElection(factory, name, admin) {
    const tx = await factory.createElection(name, CANDIDATES, COMMIT_TIME, REVEAL_TIME, admin);
    const receipt = await tx.wait();
    let votingAddress;
    let registryAddress;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "ElectionCreated") {
          votingAddress = parsed.args.voting;
          registryAddress = parsed.args.registry;
          break;
        }
      } catch {
        /* not our event */
      }
    }
    if (!votingAddress || !registryAddress) {
      throw new Error("ElectionCreated event not found");
    }
    const Voting = await ethers.getContractFactory("Voting");
    const VoterRegistry = await ethers.getContractFactory("VoterRegistry");
    return {
      voting: Voting.attach(votingAddress),
      registry: VoterRegistry.attach(registryAddress),
      votingAddress,
      registryAddress,
    };
  }

  it("deploys with the deployer as owner", async function () {
    const { factory, owner } = await deployFactoryFixture();
    expect(await factory.owner()).to.equal(owner.address);
  });

  it("creates an election with distinct voting and registry addresses", async function () {
    const { factory, admin } = await deployFactoryFixture();
    const { votingAddress, registryAddress } = await createElection(factory, "E1", admin.address);
    expect(votingAddress).to.be.properAddress;
    expect(registryAddress).to.be.properAddress;
    expect(votingAddress).to.not.equal(registryAddress);
  });

  it("emits ElectionCreated carrying name, candidates and durations", async function () {
    const { factory, admin } = await deployFactoryFixture();
    const tx = await factory.createElection("E1", CANDIDATES, COMMIT_TIME, REVEAL_TIME, admin.address);
    const receipt = await tx.wait();
    let found = null;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "ElectionCreated") {
          found = parsed.args;
          break;
        }
      } catch {
        /* not our event */
      }
    }
    expect(found).to.not.equal(null);
    expect(found.name).to.equal("E1");
    expect([...found.candidates]).to.deep.equal(CANDIDATES);
    expect(found.commitDuration).to.equal(BigInt(COMMIT_TIME));
    expect(found.revealDuration).to.equal(BigInt(REVEAL_TIME));
  });

  it("gives registry ownership to the admin, not the factory owner", async function () {
    const { factory, owner, admin } = await deployFactoryFixture();
    expect(admin.address).to.not.equal(owner.address);
    const { registry } = await createElection(factory, "E1", admin.address);
    expect(await registry.owner()).to.equal(admin.address);
  });

  it("points the new Voting contract at its own registry", async function () {
    const { factory, admin } = await deployFactoryFixture();
    const { voting, registryAddress } = await createElection(factory, "E1", admin.address);
    expect(await voting.VOTER_REGISTRY()).to.equal(registryAddress);
  });

  it("rejects createElection from non-owners", async function () {
    const { factory, admin, outsider } = await deployFactoryFixture();
    await expect(
      factory.connect(outsider).createElection("E1", CANDIDATES, COMMIT_TIME, REVEAL_TIME, admin.address)
    ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  it("rejects empty candidates via the Voting constructor", async function () {
    const { factory, admin } = await deployFactoryFixture();
    // The revert originates in the nested Voting constructor, so match it
    // against the Voting ABI (the factory ABI does not carry Voting errors).
    const Voting = await ethers.getContractFactory("Voting");
    await expect(
      factory.createElection("E1", [], COMMIT_TIME, REVEAL_TIME, admin.address)
    ).to.be.revertedWithCustomError(Voting, "NoCandidates");
  });

  it("rejects zero durations via the Voting constructor", async function () {
    const { factory, admin } = await deployFactoryFixture();
    const Voting = await ethers.getContractFactory("Voting");
    await expect(
      factory.createElection("E1", CANDIDATES, 0, REVEAL_TIME, admin.address)
    ).to.be.revertedWithCustomError(Voting, "InvalidDurations");
  });

  it("keeps voter whitelists isolated between elections", async function () {
    const { factory, owner, admin } = await deployFactoryFixture();
    const e1 = await createElection(factory, "E1", admin.address);
    const e2 = await createElection(factory, "E2", admin.address);
    const [, , , voter] = await ethers.getSigners();
    await e1.registry.connect(admin).addVoter(voter.address);
    expect(await e1.registry.isEligible(voter.address)).to.equal(true);
    expect(await e2.registry.isEligible(voter.address)).to.equal(false);
  });

  it("runs a full commit-reveal-winner cycle on a factory pair", async function () {
    const { factory, admin } = await deployFactoryFixture();
    const { voting, registry } = await createElection(factory, "E2E", admin.address);
    const [, voter1, voter2] = await ethers.getSigners();
    await registry.connect(admin).addVoter(voter1.address);
    await registry.connect(admin).addVoter(voter2.address);
    const s1 = makeSalt("f1");
    const s2 = makeSalt("f2");
    await voting.connect(voter1).commit(makeHash(0, s1));
    await voting.connect(voter2).commit(makeHash(1, s2));
    await increaseTime(COMMIT_TIME + 1);
    await voting.connect(voter1).reveal(0, s1);
    await voting.connect(voter2).reveal(1, s2);
    const [, votes, tied] = await voting.getWinner();
    expect(votes).to.equal(1);
    expect(tied).to.equal(true);
    expect(await voting.getTotalVotes()).to.equal(2);
  });
});