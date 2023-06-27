import { ethers } from "hardhat";
import { deploy } from "./common";

const main = async () => {
  const [owner] = await ethers.getSigners();
  const _ = await deploy(owner);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
