import { ethers } from "hardhat";

async function main() {
  const RingHTLC = await ethers.getContractFactory("RingHTLC");
  const ring = await RingHTLC.deploy();
  await ring.waitForDeployment();

  console.log("RingHTLC deployed to:", await ring.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
