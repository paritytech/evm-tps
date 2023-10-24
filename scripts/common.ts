import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { Wallet } from "@ethersproject/wallet";

export const deploy = async (deployer: Wallet | SignerWithAddress) => {
    console.log(`Deploying SimpleToken contract...`);
    const SimpleToken = await ethers.getContractFactory("SimpleToken", deployer);
    const token = await SimpleToken.deploy("SimpleToken", "STK", { gasLimit: 2_000_000, gasPrice: await ethers.provider.getGasPrice() });
    let tx = await token.deployed();
    console.log(`SimpleToken deployed to ${token.address}`);
    await token.deployTransaction.wait();
    return token;
}
