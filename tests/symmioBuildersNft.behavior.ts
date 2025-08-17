/* eslint-disable node/no-missing-import */
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SymmioBuildersNft } from "../typechain-types";
import { initializeFixture, RunContext } from "./Initialize.fixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import { NumberLike } from "@nomicfoundation/hardhat-network-helpers/dist/src/types";

export function shouldBehaveLikeSymmioBuildersNft() {
	let context: RunContext;
	let symmioBuildersNft: SymmioBuildersNft; // keep the same naming pattern the user showed
	let admin: SignerWithAddress;
	let user1: SignerWithAddress;
	let user2: SignerWithAddress;
	let launchTime: NumberLike;


	beforeEach(async () => {
		context = await loadFixture(initializeFixture);
		symmioBuildersNft = context.symmioBuildersNft
		;({ admin, user1, user2 } = context.signers);
	});

	/* ---------------------------------------------------------------------- */
	/*                    setPendingAmounts() tests                  */
	/* ---------------------------------------------------------------------- */
	describe("SymmioBuildersNft - mint", () => {
		it("should mint a token with correct lock data and emit event", async () => {
			const to = await user1.getAddress();
			const amount = ethers.parseEther("10");
			const name = "Test NFT";

			const tx = await symmioBuildersNft.connect(admin).mint(to, amount, name);
			const receipt = await tx.wait();
			const logs = receipt!.logs;

			const iface = symmioBuildersNft.interface;
			const parsedLog = logs
				.map((log) => {
					try {
						return iface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((log) => log?.name === "NFTMinted");

			expect(parsedLog).to.not.be.undefined;
			const tokenId = parsedLog?.args.tokenId;


			// Check token ownership
			expect(await symmioBuildersNft.ownerOf(tokenId)).to.equal(to);

			// Check lockData
			const lock = await symmioBuildersNft.lockData(tokenId);
			expect(lock.amount).to.equal(amount);
			expect(lock.name).to.equal(name);
			expect(lock.unlockingAmount).to.equal(0);
			expect(lock.lockTimestamp).to.be.gt(0);
		});

		it("should fail if caller does not have MINTER_ROLE", async () => {
			const to = await user1.getAddress();
			const amount = ethers.parseEther("5");
			const name = "Unauthorized";

			await expect(symmioBuildersNft.connect(user1).mint(to, amount, name)).to.be.rejectedWith(`AccessControl`);
		});

	});

	describe("SymmioBuildersNFT - burn", () => {
		it("should burn token and delete lockData", async () => {
			const to = await user1.getAddress();
			const amount = ethers.parseEther("10");
			const name = "Test NFT";

			const tx = await symmioBuildersNft.connect(admin).mint(to, amount, name);
			await tx.wait();

			const tokenId = 0;

			// Check lockData exists before burn
			let lock = await symmioBuildersNft.lockData(tokenId);
			expect(lock.amount).to.equal(amount);

			// Burn the token
			await expect(symmioBuildersNft.connect(admin).burn(tokenId)).to.not.be.reverted;

			lock = await symmioBuildersNft.lockData(tokenId);
			expect(lock.amount).to.equal(0);
			expect(lock.name).to.equal("");
			expect(lock.unlockingAmount).to.equal(0);
			expect(lock.lockTimestamp).to.be.equal(0);
		});

		it("should revert if caller does not have BURNER_ROLE", async () => {
			const tokenId = 0;
			await expect(symmioBuildersNft.connect(user1).burn(tokenId)).to.be.rejectedWith(`AccessControl`);
		});
	});

	describe("SymmioBuildersNft - updateLockData", function() {
		it("should allow MINTER_ROLE to update lockData and emit event", async function() {
			const to = await user1.getAddress();
			const amount = ethers.parseEther("10");
			const name = "Test NFT";

			const tx = await symmioBuildersNft.connect(admin).mint(to, amount, name);
			await tx.wait();

			const tokenId = 0;
			const newAmount = 2000;
			const newUnlockingAmount = 500;
			const newName = "Updated Name";

			await expect(symmioBuildersNft.updateLockData(tokenId, newAmount, newUnlockingAmount, newName))
				.to.emit(symmioBuildersNft, "LockDataUpdated")
				.withArgs(tokenId, newAmount, newUnlockingAmount, newName);

			const data = await symmioBuildersNft.lockData(tokenId);
			expect(data.amount).to.equal(newAmount);
			expect(data.unlockingAmount).to.equal(newUnlockingAmount);
			expect(data.name).to.equal(newName);
		});

		it("should revert if caller does not have MINTER_ROLE", async function() {
			const tokenId = 0;
			await expect(
				symmioBuildersNft.connect(user1).updateLockData(tokenId, 1, 2, "NoAccess"),
			).to.be.rejectedWith(`AccessControl`);
		});
	});
}
