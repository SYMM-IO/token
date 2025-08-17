/* eslint-disable node/no-missing-import */
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Symmio, SymmioBuildersNft, SymmioBuildersNftManager } from "../typechain-types";
import { initializeFixture, RunContext } from "./Initialize.fixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import { NumberLike } from "@nomicfoundation/hardhat-network-helpers/dist/src/types";

export function shouldBehaveLikeSymmioBuildersNftManager() {
	let context: RunContext;
	let symmioBuildersNftManager: SymmioBuildersNftManager;
	let symmioBuildersNft: SymmioBuildersNft;
	let symmioToken: Symmio;
	let admin: SignerWithAddress;
	let user1: SignerWithAddress;
	let user2: SignerWithAddress;
	let launchTime: NumberLike;
	const mintAmount = ethers.parseEther("200");
	const minLockAmount = ethers.parseEther("100");
	const brand = "MyBrand";


	beforeEach(async () => {
		context = await loadFixture(initializeFixture);
		symmioBuildersNftManager = context.symmioBuildersNftManager;
		symmioBuildersNft = context.symmioBuildersNft;
		symmioToken = context.symmioToken;
		({ admin, user1, user2 } = context.signers);

		await symmioToken.connect(admin).mint(await user1.getAddress(), mintAmount);
		await symmioToken.connect(user1).approve(await symmioBuildersNftManager.getAddress(), mintAmount);
	});

	/* ---------------------------------------------------------------------- */
	/*                    setPendingAmounts() tests                  */
	/* ---------------------------------------------------------------------- */
	describe("SymmioLocker - mintAndLock", () => {
		it("should mint and lock successfully", async () => {
			const tx = await symmioBuildersNftManager.connect(user1).mintAndLock(mintAmount, brand);
			const receipt = await tx.wait();

			const logs = receipt!.logs;

			const iface = symmioBuildersNftManager.interface;
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
			expect(await symmioBuildersNft.ownerOf(tokenId)).to.equal(await user1.getAddress());

			// Check lockData
			const lock = await symmioBuildersNft.lockData(tokenId);
			expect(lock.amount).to.equal(mintAmount);
			expect(lock.name).to.equal(brand);
			expect(lock.unlockingAmount).to.equal(0);
			expect(lock.lockTimestamp).to.be.gt(0);
		});

		it("should revert if amount < minLockAmount", async () => {
			const lowAmount = ethers.parseEther("10");
			await expect(symmioBuildersNftManager.connect(user1).mintAndLock(lowAmount, brand)).to.be.revertedWithCustomError(
				symmioBuildersNftManager,
				"AmountBelowMinimum",
			).withArgs(lowAmount, minLockAmount);
		});

		it("should burn SYMM tokens from user", async () => {
			const balanceBefore = await symmioToken.balanceOf(await user1.getAddress());
			await symmioBuildersNftManager.connect(user1).mintAndLock(mintAmount, brand);
			const balanceAfter = await symmioToken.balanceOf(await user1.getAddress());
			expect(balanceAfter).to.equal(balanceBefore - mintAmount);
		});
	});

	describe("SymmioLocker - mintWithoutBurn", function() {
		it("should mint NFT without burning and emit event", async () => {
			await expect(symmioBuildersNftManager.mintWithoutBurn(await user1.getAddress(), mintAmount, brand))
				.to.emit(symmioBuildersNftManager, "NFTMintedWithoutBurn")
				.withArgs(await admin.getAddress(), await user1.getAddress(), 0, mintAmount, brand);

			const lockData = await symmioBuildersNft.getLockData(0);
			expect(lockData.amount).to.equal(mintAmount);
			expect(lockData.name).to.equal(brand);
		});

		it("should revert if amount < minLockAmount", async () => {
			const smallAmount = ethers.parseEther("5");

			await expect(
				symmioBuildersNftManager.mintWithoutBurn(await user1.getAddress(), smallAmount, brand),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "AmountBelowMinimum");
		});

		it("should revert if recipient is zero address", async () => {
			await expect(
				symmioBuildersNftManager.mintWithoutBurn("0x0000000000000000000000000000000000000000", mintAmount, brand),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "ZeroAddress");
		});

		it("should revert if caller does not have MINTER_ROLE", async () => {
			await expect(
				symmioBuildersNftManager.connect(user1).mintWithoutBurn(await user1.getAddress(), mintAmount, brand),
			).to.be.rejectedWith("AccessControl");
		});
	});

	describe("SymmioLocker - lock", function() {
		const lockAmount = ethers.parseEther("150");

		it("should lock SYMM tokens and update lockData", async () => {
			const tx = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			const receipt = await tx.wait();

			const logs = receipt!.logs;

			const iface = symmioBuildersNftManager.interface;
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


			const before = await symmioBuildersNft.getLockData(tokenId);
			expect(before.amount).to.equal(mintAmount);

			await expect(symmioBuildersNftManager.connect(user1).lock(tokenId, lockAmount))
				.to.emit(symmioBuildersNftManager, "TokenLocked")
				.withArgs(user1.address, tokenId, lockAmount);

			const after = await symmioBuildersNft.getLockData(tokenId);
			expect(after.amount).to.equal(mintAmount + lockAmount);
		});

		it("should revert on zero amount", async () => {
			await expect(symmioBuildersNftManager.connect(user1).lock(0, 0)).to.be.rejectedWith("ZeroAmount");
		});

		it("should revert if not enough allowance", async () => {
			await symmioToken.connect(user1).approve(await symmioBuildersNftManager.getAddress(), 0);
			await expect(symmioBuildersNftManager.connect(user1).lock(0, lockAmount)).to.be.revertedWithCustomError(
				symmioToken,
				"ERC20InsufficientAllowance",
			);
		});
	});

	describe("SymmioLocker - merge()", function() {
		it("should merge source into target and burn source", async () => {
			const targetId = 0;
			const sourceId = 1;

			const tx1 = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			await tx1.wait();
			const tx2 = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			await tx2.wait();

			await expect(symmioBuildersNftManager.connect(user1).merge(targetId, sourceId))
				.to.emit(symmioBuildersNftManager, "TokensMerged")
				.withArgs(targetId, sourceId, mintAmount + mintAmount);

			const targetData = await symmioBuildersNft.getLockData(targetId);
			expect(targetData.amount).to.equal(mintAmount + mintAmount);

			await expect(symmioBuildersNft.ownerOf(sourceId)).to.be.reverted; // burned
		});

		it("should revert if caller does not own both tokens 1", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("10"), "Not yours");

			await expect(
				symmioBuildersNftManager.connect(user1).merge(0, 2),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "NotTokenOwner");
		});

		it("should revert if caller does not own both tokens 2", async () => {
			await symmioBuildersNft.mint(await user1.getAddress(), ethers.parseEther("10"), "Yours");
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("11"), "Not yours");

			await expect(
				symmioBuildersNftManager.connect(user1).merge(0, 1),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "NotTokenOwner");
		});

		it("should revert if merging same token", async () => {
			const tx = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			await tx.wait();
			await expect(
				symmioBuildersNftManager.connect(user1).merge(0, 0),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "InvalidMerge");
		});

		it("should revert if source token has unlockingAmount > 0", async () => {
			const tx1 = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			await tx1.wait();
			const tx2 = await symmioBuildersNft.connect(admin).mint(await user1.getAddress(), mintAmount, brand);
			await tx2.wait();
			const newUnlockAmount = ethers.parseEther("100");

			const tx = await symmioBuildersNftManager.connect(user1).initiateUnlock(1, newUnlockAmount);
			await tx.wait();

			await expect(
				symmioBuildersNftManager.connect(user1).merge(0, 1),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "TokenHasActiveUnlock");
		});
	});

	describe("SymmioLocker - initiateUnlock", function() {
		it("should initiate unlock with correct state", async () => {
			const unlockAmount = ethers.parseEther("50");

			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");

			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, unlockAmount);
			await tx.wait();

			const unlockData = await symmioBuildersNftManager.unlockRequests(0);

			expect(unlockData.amount).to.equal(unlockAmount);
			expect(unlockData.tokenId).to.equal(0);
			expect(unlockData.owner).to.equal(admin.address);
			expect(unlockData.vestingStarted).to.be.false;
		});

		it("should revert if not NFT owner", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("10"), "Not yours");
			await expect(symmioBuildersNftManager.connect(user1).initiateUnlock(0, ethers.parseEther("10")))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "NotTokenOwner");
		});

		it("should revert if amount is 0", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("10"), "Yours");
			await expect(symmioBuildersNftManager.connect(admin).initiateUnlock(0, 0))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "ZeroAmount");
		});

		it("should revert if amount exceeds available locked amount", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("10"), "Yours");

			const lockAmount = ethers.parseEther("100");

			await expect(symmioBuildersNftManager.connect(admin).initiateUnlock(0, lockAmount + 1n))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "InsufficientLockedAmount");
		});
	});

	describe("SymmioLocker - cancelUnlock", function() {
		it("should cancel unlock and update lockData correctly", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			const requestBefore = await symmioBuildersNftManager.unlockRequests(0);
			const dataBefore = await symmioBuildersNft.getLockData(0);

			await expect(symmioBuildersNftManager.cancelUnlock(0))
				.to.emit(symmioBuildersNftManager, "UnlockCancelled")
				.withArgs(0, 0, admin.address, requestBefore.amount);

			const requestAfter = await symmioBuildersNftManager.unlockRequests(0);
			expect(requestAfter.amount).to.equal(0);

			const dataAfter = await symmioBuildersNft.getLockData(0);
			expect(dataAfter.unlockingAmount).to.equal(dataBefore.unlockingAmount - requestBefore.amount);

			const tokenUnlockIds = await symmioBuildersNftManager.getTokenUnlockIds(0);
			expect(tokenUnlockIds).to.not.include(0);
		});

		it("should revert if caller is not unlock owner", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Not yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			await expect(symmioBuildersNftManager.connect(user1).cancelUnlock(0))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "NotTokenOwner");
		});

		it("should revert if unlock ID doesn't exist", async () => {
			await expect(symmioBuildersNftManager.cancelUnlock(9999))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "UnlockNotFound");
		});

		it("should revert if vesting already started", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			const cliff = await symmioBuildersNftManager.cliffDuration();
			await time.increase(Number(cliff) + 1);

			await symmioBuildersNftManager.completeCliffAndStartVesting(0); // assumes helper in test or mock
			await expect(symmioBuildersNftManager.cancelUnlock(0))
				.to.be.revertedWithCustomError(symmioBuildersNftManager, "VestingAlreadyStarted");
		});
	});

	describe("SymmioLocker - completeCliffAndStartVesting", function() {
		it("should complete cliff and start vesting correctly", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx1 = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx1.wait();

			// Increase time to pass cliff
			const cliff = await symmioBuildersNftManager.cliffDuration();
			await time.increase(Number(cliff) + 1);

			const dataBefore = await symmioBuildersNft.getLockData(0);

			const tx2 = await symmioBuildersNftManager.completeCliffAndStartVesting(0);
			await tx2.wait();

			const request = await symmioBuildersNftManager.unlockRequests(0);
			expect(request.vestingStarted).to.be.true;
			expect(request.vestingPlanId).to.equal(0);

			const dataAfter = await symmioBuildersNft.getLockData(0);
			expect(dataAfter.unlockingAmount).to.equal(dataBefore.unlockingAmount - request.amount);
		});

		it("should revert if cliff not passed", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			await expect(symmioBuildersNftManager.completeCliffAndStartVesting(0)).to.be.revertedWithCustomError(
				symmioBuildersNftManager,
				"CliffNotPassed",
			);
		});

		it("should revert if unlockId is invalid", async () => {
			await expect(symmioBuildersNftManager.completeCliffAndStartVesting(999)).to.be.revertedWithCustomError(
				symmioBuildersNftManager,
				"UnlockNotFound",
			);
		});

		it("should revert if not unlock owner", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			const cliff = await symmioBuildersNftManager.cliffDuration();
			await time.increase(Number(cliff) + 1);

			await expect(symmioBuildersNftManager.connect(user1).completeCliffAndStartVesting(0)).to.be.revertedWithCustomError(
				symmioBuildersNftManager,
				"NotTokenOwner",
			);
		});

		it("should revert if vesting already started", async () => {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("80"), "Yours");
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(0, ethers.parseEther("50"));
			await tx.wait();

			const cliff = await symmioBuildersNftManager.cliffDuration();
			await time.increase(Number(cliff) + 1);
			await symmioBuildersNftManager.completeCliffAndStartVesting(0);

			await expect(symmioBuildersNftManager.completeCliffAndStartVesting(0)).to.be.revertedWithCustomError(
				symmioBuildersNftManager,
				"VestingAlreadyStarted",
			);
		});

		it("should burn NFT if all amounts = 0", async () => {
			const unlockAmount = ethers.parseEther("100");

			// Mint and lock
			const tx1 = await symmioBuildersNftManager.connect(user1).mintAndLock(unlockAmount, "FullLock");
			await tx1.wait();

			const tokenId = 0;

			// Initiate full unlock
			const tx2 = await symmioBuildersNftManager.connect(user1).initiateUnlock(tokenId, unlockAmount);
			await tx2.wait();

			// Simulate that amount = 0 (manually call updateLockData)
			await symmioBuildersNft.connect(admin).updateLockData(
				tokenId,
				0,                    // amount = 0
				unlockAmount,         // unlockingAmount stays the same
				"FullLock",
			);

			// Fast-forward past cliff
			await time.increase(Number(await symmioBuildersNftManager.cliffDuration()) + 1);

			// Complete vesting
			await symmioBuildersNftManager.connect(user1).completeCliffAndStartVesting(0);

			// NFT should be burned
			await expect(symmioBuildersNft.ownerOf(tokenId)).to.be.revertedWithCustomError(
				symmioBuildersNft,
				"ERC721NonexistentToken",
			);
		});
	});

	describe("SymmioLocker - batchUpdateLockData", function() {
		it("should batch update lock data correctly", async () => {
			await symmioToken.connect(admin).mint(await user1.getAddress(), ethers.parseEther("1000"));
			await symmioToken.connect(user1).approve(await symmioBuildersNftManager.getAddress(), ethers.parseEther("1000"));

			const amount1 = ethers.parseEther("100");
			const amount2 = ethers.parseEther("200");

			// Mint two NFTs
			await symmioBuildersNftManager.connect(user1).mintAndLock(amount1, "NFT1");
			await symmioBuildersNftManager.connect(user1).mintAndLock(amount2, "NFT2");

			const tokenId1 = 0;
			const tokenId2 = 1;

			const updatedData = [
				{
					amount: ethers.parseEther("300"),
					unlockingAmount: ethers.parseEther("50"),
					name: "Updated1",
					lockTimestamp: (await time.latest()) - 1000, // or a fixed timestamp
				},
				{
					amount: ethers.parseEther("400"),
					unlockingAmount: ethers.parseEther("75"),
					name: "Updated2",
					lockTimestamp: (await time.latest()) - 2000,
				},
			];


			// Grant SYNC_ROLE to user1 (assumes DEFAULT_ADMIN_ROLE or an admin is running test)
			const SYNC_ROLE = await symmioBuildersNftManager.SYNC_ROLE();
			await symmioBuildersNftManager.grantRole(SYNC_ROLE, user1.address);

			// Call batch update
			await symmioBuildersNftManager.connect(user1).batchUpdateLockData(
				[tokenId1, tokenId2],
				updatedData,
			);

			// Verify results
			const data1 = await symmioBuildersNft.getLockData(tokenId1);
			const data2 = await symmioBuildersNft.getLockData(tokenId2);

			expect(data1.amount).to.equal(updatedData[0].amount);
			expect(data1.unlockingAmount).to.equal(updatedData[0].unlockingAmount);
			expect(data1.name).to.equal(updatedData[0].name);

			expect(data2.amount).to.equal(updatedData[1].amount);
			expect(data2.unlockingAmount).to.equal(updatedData[1].unlockingAmount);
			expect(data2.name).to.equal(updatedData[1].name);
		});

		it("should revert if tokenIds and lockDatas length mismatch", async () => {
			const SYNC_ROLE = await symmioBuildersNftManager.SYNC_ROLE();
			await symmioBuildersNftManager.grantRole(SYNC_ROLE, user1.address);

			await expect(
				symmioBuildersNftManager.connect(user1).batchUpdateLockData(
					[0], // 1 tokenId
					[
						{
							amount: ethers.parseEther("100"),
							unlockingAmount: ethers.parseEther("50"),
							name: "Mismatch",
							lockTimestamp: (await time.latest()) - 1000,

						},
						{
							amount: ethers.parseEther("200"),
							unlockingAmount: ethers.parseEther("75"),
							name: "Extra",
							lockTimestamp: (await time.latest()) - 2000,
						},
					], // 2 lockDatas
				),
			).to.be.revertedWithCustomError(symmioBuildersNftManager, "LengthMismatch");
		});
	});

	describe("SymmioBuildersNftManager - Admin Functions", function() {
		let feeCollector1 = "0x0000000000000000000000000000000000000001";
		let feeCollector2 = "0x0000000000000000000000000000000000000002";
		describe("setMinLockAmount", function() {
			it("should revert if amount = 0", async () => {
				await expect(symmioBuildersNftManager.setMinLockAmount(0))
					.to.be.revertedWithCustomError(symmioBuildersNftManager, "ZeroAmount");
			});

			it("should update minLockAmount and emit event", async () => {
				const newAmount = ethers.parseEther("100");
				await expect(symmioBuildersNftManager.setMinLockAmount(newAmount))
					.to.emit(symmioBuildersNftManager, "MinLockAmountUpdated")
					.withArgs(newAmount);

				expect(await symmioBuildersNftManager.minLockAmount()).to.equal(newAmount);
			});
		});

		describe("setCliffDuration", function() {
			it("should revert if duration = 0", async () => {
				await expect(symmioBuildersNftManager.setCliffDuration(0))
					.to.be.revertedWithCustomError(symmioBuildersNftManager, "InvalidDuration");
			});

			it("should update cliffDuration and emit event", async () => {
				const duration = 3600;
				await expect(symmioBuildersNftManager.setCliffDuration(duration))
					.to.emit(symmioBuildersNftManager, "CliffDurationUpdated")
					.withArgs(duration);

				expect(await symmioBuildersNftManager.cliffDuration()).to.equal(duration);
			});
		});

		describe("setVestingDuration", function() {
			it("should revert if duration = 0", async () => {
				await expect(symmioBuildersNftManager.setVestingDuration(0))
					.to.be.revertedWithCustomError(symmioBuildersNftManager, "InvalidDuration");
			});

			it("should update vestingDuration and emit event", async () => {
				const duration = 86400;
				await expect(symmioBuildersNftManager.setVestingDuration(duration))
					.to.emit(symmioBuildersNftManager, "VestingDurationUpdated")
					.withArgs(duration);

				expect(await symmioBuildersNftManager.vestingDuration()).to.equal(duration);
			});
		});

		describe("addFeeCollector / removeFeeCollector", function() {
			const tokenId = 0;

			it("should add fee collectors and emit events", async () => {
				await expect(symmioBuildersNftManager.addFeeCollector(tokenId, [feeCollector1, feeCollector2]))
					.to.emit(symmioBuildersNftManager, "FeeCollectorAdded").withArgs(tokenId, feeCollector1)
					.and.to.emit(symmioBuildersNftManager, "FeeCollectorAdded").withArgs(tokenId, feeCollector2);

				const collectors = await symmioBuildersNftManager.getTokenFeeCollectors(tokenId);
				expect(collectors).to.include(feeCollector1);
				expect(collectors).to.include(feeCollector2);
			});

			it("should remove fee collector and emit event", async () => {
				await symmioBuildersNftManager.addFeeCollector(tokenId, [feeCollector1]);
				await expect(symmioBuildersNftManager.removeFeeCollector(tokenId, feeCollector1))
					.to.emit(symmioBuildersNftManager, "FeeCollectorRemoved").withArgs(tokenId, feeCollector1);

				const collectors = await symmioBuildersNftManager.getTokenFeeCollectors(tokenId);
				expect(collectors).to.not.include(feeCollector1);
			});
		});

		describe("role restrictions", function() {
			it("non-setter should be reverted", async () => {
				await expect(symmioBuildersNftManager.connect(user1).setMinLockAmount(100)).to.be.rejectedWith("AccessControl");
			});
		});
	});

	describe("SymmioBuildersNftManager - View Functions", function() {
		let tokenId = 0;
		beforeEach(async function() {
			await symmioBuildersNft.mint(await admin.getAddress(), ethers.parseEther("1000"), "Yours");

			// set cliff duration
			await symmioBuildersNftManager.setCliffDuration(1000); // e.g., 1000s
		});

		async function createUnlock(amount: bigint) {
			const tx = await symmioBuildersNftManager.connect(admin).initiateUnlock(tokenId, amount);
			await tx.wait();
			return tx;
		}

		describe("getUnlockedRequests", function() {
			it("should return empty array if no unlocks", async () => {
				const requests = await symmioBuildersNftManager.getUnlockedRequests(tokenId, 0, 10, 10);
				expect(requests.length).to.equal(0n);
			});

			it("should return unlock requests with correct pagination", async () => {
				// Create 3 unlocks
				await createUnlock(ethers.parseEther("100"));
				await createUnlock(ethers.parseEther("200"));
				await createUnlock(ethers.parseEther("300"));

				// Fetch first 2
				const reqs1 = await symmioBuildersNftManager.getUnlockedRequests(tokenId, 0, 2, 10);
				expect(reqs1.length).to.equal(2n);
				expect(reqs1[0].amount).to.equal(ethers.parseEther("100"));
				expect(reqs1[1].amount).to.equal(ethers.parseEther("200"));

				// Fetch with size limit = 1
				const reqs2 = await symmioBuildersNftManager.getUnlockedRequests(tokenId, 0, 3, 1);
				expect(reqs2.length).to.equal(1n);
				expect(reqs2[0].amount).to.equal(ethers.parseEther("100"));
			});
		});

		describe("getCliffEndTime", function() {
			it("should revert if unlock not found", async () => {
				await expect(symmioBuildersNftManager.getCliffEndTime(0)).to.be.revertedWithCustomError(
					symmioBuildersNftManager,
					"UnlockNotFound",
				);
			});

			it("should return correct cliff end time", async () => {
				const tx = await createUnlock(ethers.parseEther("100"));

				const block = await ethers.provider.getBlock(tx.blockNumber!);

				const cliffEnd = await symmioBuildersNftManager.getCliffEndTime(0);
				expect(cliffEnd).to.equal(block!.timestamp + 1000);
			});
		});

		describe("isCliffPassed", function() {
			it("should revert if unlock not found", async () => {
				await expect(symmioBuildersNftManager.isCliffPassed(0)).to.be.revertedWithCustomError(
					symmioBuildersNftManager,
					"UnlockNotFound",
				);
			});

			it("should return false before cliff", async () => {
				await createUnlock(ethers.parseEther("100"));
				expect(await symmioBuildersNftManager.isCliffPassed(0)).to.equal(false);
			});

			it("should return true after cliff time passes", async () => {
				await createUnlock(ethers.parseEther("100"));
				await ethers.provider.send("evm_increaseTime", [2000]); // move forward
				await ethers.provider.send("evm_mine");

				expect(await symmioBuildersNftManager.isCliffPassed(0)).to.equal(true);
			});
		});
	});
}
