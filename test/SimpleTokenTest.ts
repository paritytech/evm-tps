import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { SimpleToken } from "../typechain-types";

import { expect } from "chai";
import { ethers } from "hardhat";

describe("Lock", function () {
  let token: SimpleToken, alice: SignerWithAddress, bob: SignerWithAddress, owner: SignerWithAddress;
  const amountToMint = Math.pow(10, 8);

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    const SimpleToken = await ethers.getContractFactory("SimpleToken", owner);
    token = await SimpleToken.deploy("SimpleToken", "STK");
    await token.deployed();
  });

  describe("Test", function () {
    it("One", async () => {
      await expect(token.connect(alice).mintTo(alice.address, amountToMint)).to.be.revertedWith(
        "Onwer has not started the contract yet."
      );
      await expect(token.connect(alice).start()).to.be.revertedWith(
        "Only owner can start it."
      );
      await token.start();
      expect(await token.connect(alice).mintTo(alice.address, amountToMint));
    });

    it("Two", async () => {
      await token.start();
      expect(await token.mintTo(alice.address, amountToMint));
      let aliceAmount = await token.balanceOf(alice.address);
      expect(aliceAmount).to.equal(amountToMint, `alice should have ${amountToMint} tokens but she has ${aliceAmount}.`);
    });

    it("Three", async () => {
      await token.start();
      expect(await token.mintTo(owner.address, amountToMint));
      expect(await token.transferLoop(7, alice.address, 5));
      let aliceAmount = await token.balanceOf(alice.address);
      expect(aliceAmount).to.equal(7 * 5, `alice should have ${7 * 5} tokens but she has ${aliceAmount}.`);
    });

  });
});
