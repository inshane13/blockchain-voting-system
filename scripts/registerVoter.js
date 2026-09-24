import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import hre from "hardhat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error("deployments.json not found. Run deploy first.");
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const registryAddress = deployments.voterRegistry;
  if (!registryAddress) {
    throw new Error("voterRegistry address missing from deployments.json");
  }

  const [deployer] = await hre.ethers.getSigners();
  const voter = (process.argv[2] && process.argv[2].trim()) || deployer.address;
  if (!hre.ethers.isAddress(voter)) {
    throw new Error(`Invalid voter address: ${voter}`);
  }

  console.log(`Registering ${voter} on VoterRegistry at ${registryAddress}...`);

  const VoterRegistry = await hre.ethers.getContractFactory("VoterRegistry");
  const registry = VoterRegistry.attach(registryAddress);

  const tx = await registry.addVoter(voter);
  await tx.wait();

  const eligible = await registry.isEligible(voter);
  console.log(`isEligible(${voter}) = ${eligible}`);
  if (!eligible) throw new Error("Voter was not registered");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });