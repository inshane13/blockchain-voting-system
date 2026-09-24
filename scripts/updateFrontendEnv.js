import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const deploymentsPath = path.join(__dirname, "..", "deployments.json");
if (!fs.existsSync(deploymentsPath)) {
  throw new Error("deployments.json not found. Run deploy first.");
}
const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

const rpcUrlRaw = process.env.SEPOLIA_URL || process.env.POLYGON_URL;
if (!rpcUrlRaw) {
  console.warn("Warning: neither SEPOLIA_URL nor POLYGON_URL is set; writing empty RPC URL.");
}
const networkId = process.env.NEXT_PUBLIC_NETWORK_ID || 11155111;

const envContent = `# Auto-generated from deployments.json on ${deployments.timestamp}
NEXT_PUBLIC_VOTING_ADDRESS=${deployments.voting}
NEXT_PUBLIC_VOTER_REGISTRY_ADDRESS=${deployments.voterRegistry}
NEXT_PUBLIC_NETWORK_ID=${networkId}
NEXT_PUBLIC_RPC_URL=${rpcUrlRaw || ""}
`;

fs.writeFileSync(path.join(__dirname, "..", "frontend", ".env.local"), envContent);
console.log("Updated frontend/.env.local");
console.log("Voting Address:", deployments.voting);
console.log("VoterRegistry Address:", deployments.voterRegistry);
console.log("Restart the frontend dev server to pick up changes.");