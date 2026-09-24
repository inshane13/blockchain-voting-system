import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import hre from "hardhat";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const VoterRegistry = await hre.ethers.getContractFactory("VoterRegistry");
  const voterRegistry = await VoterRegistry.deploy(deployer.address);
  await voterRegistry.waitForDeployment();
  const registryAddress = await voterRegistry.getAddress();
  console.log("VoterRegistry deployed to:", registryAddress);

  const candidates = ["Alice", "Bob", "Charlie"];
  const commitTime = 3600; // 1 hour
  const revealTime = 3600; // 1 hour

  const Voting = await hre.ethers.getContractFactory("Voting");
  const voting = await Voting.deploy(
    "General Election",
    candidates,
    commitTime,
    revealTime,
    registryAddress
  );
  await voting.waitForDeployment();
  const votingAddress = await voting.getAddress();
  console.log("Voting deployed to:", votingAddress);

  const deploymentInfo = {
    voterRegistry: registryAddress,
    voting: votingAddress,
    deployer: deployer.address,
    network: hre.network.name,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(__dirname, "..", "deployments.json"),
    JSON.stringify(deploymentInfo, null, 2)
  );

  const rpcUrlRaw = process.env.SEPOLIA_URL || process.env.POLYGON_URL;
  if (!rpcUrlRaw) {
    console.warn("Warning: neither SEPOLIA_URL nor POLYGON_URL is set; writing empty RPC URL.");
  }
  const networkId = hre.network.config.chainId || 11155111;

  const envContent = `# Auto-generated from deployment on ${deploymentInfo.timestamp}
NEXT_PUBLIC_VOTING_ADDRESS=${votingAddress}
NEXT_PUBLIC_VOTER_REGISTRY_ADDRESS=${registryAddress}
NEXT_PUBLIC_NETWORK_ID=${networkId}
NEXT_PUBLIC_RPC_URL=${rpcUrlRaw || ""}
`;

  fs.writeFileSync(path.join(__dirname, "..", "frontend", ".env.local"), envContent);
  console.log("Wrote deployments.json and frontend/.env.local");

  console.log("\nDeployment complete.");
  console.log("VoterRegistry:", registryAddress);
  console.log("Voting:", votingAddress);
  console.log("Restart the frontend dev server to pick up the new contract addresses.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });