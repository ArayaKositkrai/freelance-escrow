const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const escrow = await hre.ethers.deployContract("FreelanceEscrow");
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  const { chainId } = await hre.ethers.provider.getNetwork();

  console.log("FreelanceEscrow deployed to:", address);
  console.log("Tx hash:", escrow.deploymentTransaction().hash);

  // อัปเดต address ให้หน้าเว็บอัตโนมัติ
  const cfgPath = path.join(__dirname, "..", "docs", "config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/CONTRACT_ADDRESS:\s*"[^"]*"/, `CONTRACT_ADDRESS: "${address}"`);
  cfg = cfg.replace(/CHAIN_ID:\s*\d+/, `CHAIN_ID: ${chainId}`);
  const receipt = await escrow.deploymentTransaction().wait();
  cfg = cfg.replace(/DEPLOY_BLOCK:\s*\d+/, `DEPLOY_BLOCK: ${receipt.blockNumber}`);
  fs.writeFileSync(cfgPath, cfg);
  console.log("Updated docs/config.js");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
