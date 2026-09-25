import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Network:", hre.network.name);

  // 1. VotingFactory
  const Factory = await hre.ethers.getContractFactory("VotingFactory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("VotingFactory:", factoryAddress);

  // 2. Create first election via factory
  const candidates = ["Alice", "Bob", "Charlie"];
  const commitDuration = 3600;
  const revealDuration = 3600;

  const tx = await factory.createElection(
    "General Election",
    candidates,
    commitDuration,
    revealDuration,
    deployer.address // admin of the new registry
  );
  const receipt = await tx.wait();

  // Parse ElectionCreated event
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
    throw new Error("Failed to parse ElectionCreated event");
  }

  console.log("Voting:", votingAddress);
  console.log("VoterRegistry:", registryAddress);

  // 3. Persist deployments.json
  const deployments = {
    factory: factoryAddress,
    voterRegistry: registryAddress,
    voting: votingAddress,
    deployer: deployer.address,
    network: hre.network.name,
    timestamp: new Date().toISOString(),
  };
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("Wrote deployments.json");

  // 4. Write frontend/.env.local
  const networkId =
    hre.network.config.chainId?.toString() ||
    process.env.NEXT_PUBLIC_NETWORK_ID ||
    "11155111";
  const rpcUrl =
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.SEPOLIA_URL ||
    "http://127.0.0.1:8545";

  const envLocal = [
    `NEXT_PUBLIC_VOTING_ADDRESS=${votingAddress}`,
    `NEXT_PUBLIC_VOTER_REGISTRY_ADDRESS=${registryAddress}`,
    `NEXT_PUBLIC_FACTORY_ADDRESS=${factoryAddress}`,
    `NEXT_PUBLIC_NETWORK_ID=${networkId}`,
    `NEXT_PUBLIC_RPC_URL=${rpcUrl}`,
  ].join("\n");

  const frontendEnvPath = path.join(__dirname, "..", "frontend", ".env.local");
  fs.mkdirSync(path.dirname(frontendEnvPath), { recursive: true });
  fs.writeFileSync(frontendEnvPath, envLocal + "\n");
  console.log("Wrote frontend/.env.local");

  console.log("\nDeploy complete. Next:");
  console.log(
    "  npx hardhat run scripts/registerVoter.js --network",
    hre.network.name
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});