import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const CANDIDATES = ["Alice", "Bob"];
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
    expect(await voting.getCandidatesCount()).to.equal(2);
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

  it("flags a tie via getWinner", async function () {
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
});