import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"

import { Symmio, SymmioBuildersNft, SymmioBuildersNftManager } from "../typechain-types"
import { initializeFixture, RunContext } from "./Initialize.fixture"

export function shouldBehaveLikeSymmioBuildersNftManager() {
	let context: RunContext
	let manager: SymmioBuildersNftManager
	let nft: SymmioBuildersNft
	let symm: Symmio
	let admin: SignerWithAddress
	let user1: SignerWithAddress
	let user2: SignerWithAddress
	let penaltyReceiver: SignerWithAddress

	const minLockAmount = ethers.parseEther("100")
	const fundedAmount = ethers.parseEther("1000")
	const cliffDuration = 10n
	const vestingDuration = 3600n
	const penaltyRate = ethers.parseUnits("0.2", 18)
	const maxUserActiveUnlockRequests = 10n
	const brand = "Builder"

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		manager = context.symmioBuildersNftManager
		nft = context.symmioBuildersNft
		symm = context.symmioToken
		;({ admin, user1, user2, vestingPenaltyReceiver: penaltyReceiver } = context.signers)

		await (await symm.connect(admin).mint(user1.address, fundedAmount)).wait()
		await (await symm.connect(admin).mint(user2.address, fundedAmount)).wait()
		await (await symm.connect(user1).approve(await manager.getAddress(), fundedAmount)).wait()
		await (await symm.connect(user2).approve(await manager.getAddress(), fundedAmount)).wait()
	})

	async function createFlow(beneficiary: SignerWithAddress, tokenId: bigint, unlockId: bigint, amount: bigint): Promise<bigint> {
		await manager.connect(admin).mintWithoutBurn(beneficiary.address, amount, `${brand}-${tokenId}`)
		await manager.connect(beneficiary).initiateUnlock(tokenId, amount)
		await time.increase(Number(await manager.cliffDuration()) + 1)
		await manager.connect(beneficiary).completeCliffAndStartVesting(unlockId)
		return (await manager.unlockRequests(unlockId)).vestingFlowId
	}

	describe("initialization and deployment wiring", () => {
		it("uses the explicitly supplied economic configuration", async () => {
			expect(await manager.SYMM()).to.equal(await symm.getAddress())
			expect(await manager.nftContract()).to.equal(await nft.getAddress())
			expect(await manager.minLockAmount()).to.equal(minLockAmount)
			expect(await manager.cliffDuration()).to.equal(cliffDuration)
			expect(await manager.vestingDuration()).to.equal(vestingDuration)
			expect(await manager.lockedClaimPenaltyRate()).to.equal(penaltyRate)
			expect(await manager.lockedClaimPenaltyReceiver()).to.equal(penaltyReceiver.address)
			expect(await manager.maxUserActiveUnlockRequests()).to.equal(maxUserActiveUnlockRequests)
		})

		it("grants the manager every required token and NFT role", async () => {
			const managerAddress = await manager.getAddress()
			expect(await symm.hasRole(await symm.MINTER_ROLE(), managerAddress)).to.equal(true)
			expect(await nft.hasRole(await nft.MINTER_ROLE(), managerAddress)).to.equal(true)
			expect(await nft.hasRole(await nft.BURNER_ROLE(), managerAddress)).to.equal(true)
			expect(await nft.hasRole(await nft.PAUSER_ROLE(), managerAddress)).to.equal(true)
			expect(await nft.hasRole(await nft.UNPAUSER_ROLE(), managerAddress)).to.equal(true)
		})
	})

	describe("locking and NFT management", () => {
		it("burns SYMM and mints an NFT with matching lock data", async () => {
			const before = await symm.balanceOf(user1.address)
			await expect(manager.connect(user1).mintAndLock(minLockAmount, brand))
				.to.emit(manager, "NFTMinted")
				.withArgs(user1.address, 0, minLockAmount, brand)

			const data = await nft.getLockData(0)
			expect(await symm.balanceOf(user1.address)).to.equal(before - minLockAmount)
			expect(await nft.ownerOf(0)).to.equal(user1.address)
			expect(data.amount).to.equal(minLockAmount)
			expect(data.unlockingAmount).to.equal(0)
		})

		it("rejects amounts below the configured minimum", async () => {
			const amount = minLockAmount - 1n
			await expect(manager.connect(user1).mintAndLock(amount, brand))
				.to.be.revertedWithCustomError(manager, "AmountBelowMinimum")
				.withArgs(amount, minLockAmount)
		})

		it("locks additional tokens into an owned NFT", async () => {
			await manager.connect(user1).mintAndLock(minLockAmount, brand)
			const additionalAmount = ethers.parseEther("25")
			const balanceBefore = await symm.balanceOf(user1.address)

			await expect(manager.connect(user1).lockIntoNFT(0, additionalAmount))
				.to.emit(manager, "TokenLocked")
				.withArgs(user1.address, 0, additionalAmount)

			expect((await nft.getLockData(0)).amount).to.equal(minLockAmount + additionalAmount)
			expect(await symm.balanceOf(user1.address)).to.equal(balanceBefore - additionalAmount)
		})

		it("rejects additional locks from non-owners", async () => {
			await manager.connect(user1).mintAndLock(minLockAmount, brand)
			await expect(manager.connect(user2).lockIntoNFT(0, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		})

		it("merges two owned NFTs and burns the source", async () => {
			await manager.connect(user1).mintAndLock(minLockAmount, "Target")
			await manager.connect(user1).mintAndLock(minLockAmount, "Source")

			await expect(manager.connect(user1).merge(0, 1))
				.to.emit(manager, "TokensMerged")
				.withArgs(0, 1, minLockAmount * 2n)
			expect((await nft.getLockData(0)).amount).to.equal(minLockAmount * 2n)
			await expect(nft.ownerOf(1)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
		})
	})

	describe("unlock lifecycle", () => {
		it("enforces the per-user active unlock request limit and releases a slot on cancellation", async () => {
			const maximum = 2n
			await manager.connect(admin).setMaxUserActiveUnlockRequests(maximum)
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount * 3n, brand)

			await manager.connect(user1).initiateUnlock(0, minLockAmount)
			await manager.connect(user1).initiateUnlock(0, minLockAmount)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(maximum)

			await expect(manager.connect(user1).initiateUnlock(0, minLockAmount))
				.to.be.revertedWithCustomError(manager, "MaxUserActiveUnlockRequestsReached")
				.withArgs(user1.address, maximum)

			await manager.connect(user1).cancelUnlock(0)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(1)

			await manager.connect(user1).initiateUnlock(0, minLockAmount)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(maximum)
		})

		it("keeps a request active during vesting and releases its slot after full settlement", async () => {
			await manager.connect(admin).setMaxUserActiveUnlockRequests(1)
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount, "First")
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount, "Second")

			await manager.connect(user1).initiateUnlock(0, minLockAmount)
			await time.increase(Number(cliffDuration) + 1)
			await manager.connect(user1).completeCliffAndStartVesting(0)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(1)
			await expect(manager.connect(user1).initiateUnlock(1, minLockAmount)).to.be.revertedWithCustomError(
				manager,
				"MaxUserActiveUnlockRequestsReached",
			)

			const request = await manager.unlockRequests(0)
			await time.increaseTo(Number(request.vestingEndTime + 1n))
			await manager.connect(user1).claimUnlockedToken(request.vestingFlowId)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(0)

			await manager.connect(user1).initiateUnlock(1, minLockAmount)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(1)
		})

		it("creates and cancels an unlock request while preserving accounting", async () => {
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount, brand)
			const unlockAmount = ethers.parseEther("40")

			await expect(manager.connect(user1).initiateUnlock(0, unlockAmount)).to.emit(manager, "UnlockInitiated")
			const request = await manager.unlockRequests(0)
			expect(request.amount).to.equal(unlockAmount)
			expect(request.owner).to.equal(user1.address)
			expect(request.vestingStartTime).to.equal(0)
			expect(request.vestingEndTime).to.equal(0)
			expect(request.netClaimedAmount).to.equal(0)
			expect((await nft.getLockData(0)).unlockingAmount).to.equal(unlockAmount)
			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, 0)).to.be.revertedWithCustomError(nft, "TokenHasActiveUnlock")

			await expect(manager.connect(user1).cancelUnlock(0)).to.emit(manager, "UnlockCancelled").withArgs(0, 0, user1.address, unlockAmount)
			expect((await nft.getLockData(0)).unlockingAmount).to.equal(0)
			expect((await manager.unlockRequests(0)).amount).to.equal(0)
		})

		it("starts vesting only after the cliff and updates the NFT", async () => {
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount, brand)
			const unlockAmount = ethers.parseEther("40")
			await manager.connect(user1).initiateUnlock(0, unlockAmount)

			await expect(manager.connect(user1).completeCliffAndStartVesting(0)).to.be.revertedWithCustomError(manager, "CliffNotPassed")
			await time.increase(Number(cliffDuration) + 1)
			await expect(manager.connect(user1).completeCliffAndStartVesting(0)).to.emit(manager, "VestingStarted")

			const request = await manager.unlockRequests(0)
			const data = await nft.getLockData(0)
			expect(request.vestingFlowId).to.equal(0)
			expect(request.vestingStartTime).to.equal(request.unlockInitiatedTime + cliffDuration)
			expect(request.vestingEndTime).to.equal(request.vestingStartTime + vestingDuration)
			expect(request.netClaimedAmount).to.equal(0)
			const [, flows] = await manager.getUserFlows(user1.address, 0, 1)
			expect(flows[0].reqId).to.equal(0)
			expect(flows[0].startTime).to.equal(request.vestingStartTime)
			expect(flows[0].endTime).to.equal(request.vestingEndTime)
			expect(data.amount).to.equal(minLockAmount - unlockAmount)
			expect(data.unlockingAmount).to.equal(0)
		})
	})

	describe("vesting claims and views", () => {
		it("returns frontend-ready NFT, unlock, and vesting details", async () => {
			const tokenAmount = minLockAmount * 2n
			const firstUnlockAmount = minLockAmount
			const secondUnlockAmount = minLockAmount / 2n
			await manager.connect(admin).mintWithoutBurn(user1.address, tokenAmount, brand)
			await manager.connect(user1).initiateUnlock(0, firstUnlockAmount)
			await manager.connect(user1).initiateUnlock(0, secondUnlockAmount)
			await time.increase(Number(cliffDuration) + 1)
			await manager.connect(user1).completeCliffAndStartVesting(0)
			await time.increase(Number(vestingDuration / 4n))

			const details = await manager.getTokenDetails(0)
			expect(details.tokenId).to.equal(0)
			expect(details.owner).to.equal(user1.address)
			expect(details.unlockRequests).to.have.length(2)

			const startedRequest = details.unlockRequests[0]
			expect(startedRequest.unlockRequestId).to.equal(0)
			expect(startedRequest.amount).to.equal(firstUnlockAmount)
			expect(startedRequest.unlockInitiatedTime).to.be.greaterThan(0)
			expect(startedRequest.cliffEndTime).to.equal(startedRequest.vestingStartTime)
			expect(startedRequest.vestingFlowId).to.equal(0)
			expect(startedRequest.vestingStartTime).to.be.greaterThan(0)
			expect(startedRequest.vestingEndTime).to.equal(startedRequest.vestingStartTime + vestingDuration)
			expect(startedRequest.lockedAmount + startedRequest.claimableAmount).to.equal(firstUnlockAmount)
			expect(startedRequest.netClaimedAmount).to.equal(0)

			const pendingRequest = details.unlockRequests[1]
			expect(pendingRequest.unlockRequestId).to.equal(1)
			expect(pendingRequest.amount).to.equal(secondUnlockAmount)
			expect(pendingRequest.cliffEndTime).to.equal(pendingRequest.unlockInitiatedTime + cliffDuration)
			expect(pendingRequest.vestingFlowId).to.equal(0)
			expect(pendingRequest.vestingStartTime).to.equal(0)
			expect(pendingRequest.vestingEndTime).to.equal(0)
			expect(pendingRequest.lockedAmount).to.equal(0)
			expect(pendingRequest.claimableAmount).to.equal(0)
			expect(pendingRequest.netClaimedAmount).to.equal(0)

			const page = await manager.getUnlockedRequests(0, 1, 10)
			expect(page).to.have.length(1)
			expect(page[0].amount).to.equal(secondUnlockAmount)
			expect(await manager.getUnlockedRequests(0, 2, 10)).to.have.length(0)
		})

		it("preserves unlock and vesting details after the NFT is burned", async () => {
			await createFlow(user1, 0n, 0n, minLockAmount)

			const details = await manager.getTokenDetails(0)
			expect(details.tokenId).to.equal(0)
			expect(details.owner).to.equal(ethers.ZeroAddress)
			expect(details.unlockRequests).to.have.length(1)
			expect(details.unlockRequests[0].vestingStartTime).to.be.greaterThan(0)
			expect(details.unlockRequests[0].vestingEndTime).to.be.greaterThan(details.unlockRequests[0].vestingStartTime)
			expect(details.unlockRequests[0].lockedAmount + details.unlockRequests[0].claimableAmount).to.equal(minLockAmount)
		})

		it("preserves principal across repeated partial claims (BNF-01 regression)", async () => {
			const amount = minLockAmount
			const flowId = await createFlow(user1, 0n, 0n, amount)
			const balanceBefore = await symm.balanceOf(user1.address)

			await time.increase(Number(vestingDuration / 3n))
			await manager.connect(user1).claimUnlockedToken(flowId)
			let [, flows] = await manager.getUserFlows(user1.address, 0, 1)
			let totalClaimed = (await symm.balanceOf(user1.address)) - balanceBefore
			expect((await manager.unlockRequests(0)).netClaimedAmount).to.equal(totalClaimed)
			expect(flows[0].amount).to.equal(amount - totalClaimed)
			expect(await manager.totalVested()).to.equal(flows[0].amount)

			const midpoint = (flows[0].startTime + flows[0].endTime) / 2n
			await time.increaseTo(Number(midpoint))
			await manager.connect(user1).claimUnlockedToken(flowId)
			;[, flows] = await manager.getUserFlows(user1.address, 0, 1)
			totalClaimed = (await symm.balanceOf(user1.address)) - balanceBefore
			expect((await manager.unlockRequests(0)).netClaimedAmount).to.equal(totalClaimed)
			expect(totalClaimed).to.be.lessThan(amount)
			expect(totalClaimed + flows[0].amount).to.equal(amount)
			expect(await manager.totalVested()).to.equal(flows[0].amount)

			await time.increaseTo(Number(flows[0].endTime + 1n))
			await manager.connect(user1).claimUnlockedToken(flowId)
			expect((await symm.balanceOf(user1.address)) - balanceBefore).to.equal(amount)
			expect((await manager.unlockRequests(0)).netClaimedAmount).to.equal(amount)
			expect(await manager.totalVested()).to.equal(0)
			expect(await manager.getUserFlowCount(user1.address)).to.equal(0)
		})

		it("reports consistent per-flow and aggregate locked and claimable amounts", async () => {
			const flowId = await createFlow(user1, 0n, 0n, minLockAmount)
			await time.increase(Number(vestingDuration / 4n))

			const locked = await manager.getLockedAmountForFlow(flowId)
			const claimable = await manager.getClaimableAmountForFlow(flowId)
			expect(locked + claimable).to.equal(minLockAmount)
			expect(await manager.getTotalLockedAmount(user1.address)).to.equal(locked)
			expect(await manager.getTotalClaimableAmount(user1.address)).to.equal(claimable)
			expect(await manager.getLockedAmountForFlow(999)).to.equal(0)
			expect(await manager.getClaimableAmountForFlow(999)).to.equal(0)
		})

		it("paginates active flows with aligned IDs and flow data", async () => {
			const firstAmount = minLockAmount
			const secondAmount = minLockAmount * 2n
			await manager.connect(admin).mintWithoutBurn(user1.address, firstAmount, "First")
			await manager.connect(admin).mintWithoutBurn(user1.address, secondAmount, "Second")
			await manager.connect(user1).initiateUnlock(0, firstAmount)
			await manager.connect(user1).initiateUnlock(1, secondAmount)
			await time.increase(Number(cliffDuration) + 1)
			await manager.connect(user1).completeCliffAndStartVesting(0)
			await manager.connect(user1).completeCliffAndStartVesting(1)

			expect(await manager.getUserFlowCount(user1.address)).to.equal(2)
			const [firstIds, firstFlows] = await manager.getUserFlows(user1.address, 0, 1)
			const [secondIds, secondFlows] = await manager.getUserFlows(user1.address, 1, 10)
			const [emptyIds, emptyFlows] = await manager.getUserFlows(user1.address, 2, 1)
			expect(firstIds).to.deep.equal([0n])
			expect(firstFlows[0].reqId).to.equal(0)
			expect(firstFlows[0].amount).to.equal(firstAmount)
			expect(secondIds).to.deep.equal([1n])
			expect(secondFlows[0].reqId).to.equal(1)
			expect(secondFlows[0].amount).to.equal(secondAmount)
			expect(emptyIds).to.have.length(0)
			expect(emptyFlows).to.have.length(0)
		})

		it("claims unvested principal with the configured penalty", async () => {
			const flowId = await createFlow(user1, 0n, 0n, minLockAmount)
			const lockedToClaim = ethers.parseEther("20")
			const expectedPenalty = (lockedToClaim * penaltyRate) / ethers.parseEther("1")
			const receiverBefore = await symm.balanceOf(penaltyReceiver.address)
			const userBefore = await symm.balanceOf(user1.address)
			const vestedBefore = await manager.totalVested()

			await expect(manager.connect(user1).claimLockedToken(flowId, lockedToClaim))
				.to.emit(manager, "LockedTokenClaimed")
				.withArgs(user1.address, flowId, lockedToClaim, expectedPenalty)

			const receiverDelta = (await symm.balanceOf(penaltyReceiver.address)) - receiverBefore
			const userDelta = (await symm.balanceOf(user1.address)) - userBefore
			const vestedDelta = vestedBefore - (await manager.totalVested())
			const request = await manager.unlockRequests(0)
			expect(receiverDelta).to.equal(expectedPenalty)
			expect(userDelta + receiverDelta).to.equal(vestedDelta)
			expect(request.netClaimedAmount).to.equal(userDelta)
			expect(request.netClaimedAmount + receiverDelta).to.equal(vestedDelta)
		})

		it("releases the active request slot after claiming the entire unvested balance", async () => {
			await manager.connect(admin).setMaxUserActiveUnlockRequests(1)
			const flowId = await createFlow(user1, 0n, 0n, minLockAmount)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(1)

			await manager.connect(user1).claimLockedToken(flowId, minLockAmount)
			expect(await manager.userActiveUnlockRequestCount(user1.address)).to.equal(0)
		})
	})

	describe("system pause", () => {
		it("atomically pauses and unpauses manager and NFT operations", async () => {
			await manager.connect(admin).mintWithoutBurn(user1.address, minLockAmount, brand)
			await expect(manager.connect(admin).pause()).to.emit(manager, "Paused").withArgs(admin.address)
			expect(await manager.paused()).to.equal(true)
			expect(await nft.paused()).to.equal(true)

			await expect(manager.connect(user1).mintAndLock(minLockAmount, brand)).to.be.revertedWithCustomError(manager, "EnforcedPause")
			await expect(nft.connect(admin).updateLockData(0, minLockAmount, 0, brand)).to.be.revertedWithCustomError(nft, "EnforcedPause")
			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, 0)).to.be.revertedWithCustomError(nft, "TransfersPaused")

			await expect(manager.connect(admin).unpause()).to.emit(manager, "Unpaused").withArgs(admin.address)
			expect(await manager.paused()).to.equal(false)
			expect(await nft.paused()).to.equal(false)
			await nft.connect(user1).transferFrom(user1.address, user2.address, 0)
			expect(await nft.ownerOf(0)).to.equal(user2.address)
		})

		it("can complete a system pause when the NFT was already paused", async () => {
			await nft.connect(admin).pause()
			await manager.connect(admin).pause()
			expect(await manager.paused()).to.equal(true)
			expect(await nft.paused()).to.equal(true)

			await manager.connect(admin).unpause()
			expect(await manager.paused()).to.equal(false)
			expect(await nft.paused()).to.equal(false)
		})
	})

	describe("administration and synchronization", () => {
		it("updates nonzero configuration values and restricts setters", async () => {
			await expect(manager.connect(admin).setMinLockAmount(0)).to.be.revertedWithCustomError(manager, "ZeroAmount")
			await expect(manager.connect(admin).setCliffDuration(0)).to.be.revertedWithCustomError(manager, "InvalidDuration")
			await expect(manager.connect(admin).setVestingDuration(0)).to.be.revertedWithCustomError(manager, "InvalidDuration")
			await expect(manager.connect(admin).setMaxUserActiveUnlockRequests(0)).to.be.revertedWithCustomError(manager, "ZeroAmount")
			await expect(manager.connect(user1).setMinLockAmount(1))
				.to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
				.withArgs(user1.address, await manager.SETTER_ROLE())
			await expect(manager.connect(admin).setMaxUserActiveUnlockRequests(5))
				.to.emit(manager, "MaxUserActiveUnlockRequestsUpdated")
				.withArgs(5)
		})
	})
}
