import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers, upgrades } from "hardhat"

import type { Symmio, SymmioBuildersNft, SymmioBuildersNftManager } from "../typechain-types"
import { initializeFixture } from "./Initialize.fixture"

export function shouldBehaveLikeSymmioBuildersNftPledge() {
	let manager: SymmioBuildersNftManager
	let nft: SymmioBuildersNft
	let symm: Symmio
	let admin: SignerWithAddress
	let builder: SignerWithAddress
	let other: SignerWithAddress
	let managerAddress: string
	const amount = ethers.parseEther("100")
	const brand = "Pledged builder"

	beforeEach(async () => {
		const context = await loadFixture(initializeFixture)
		manager = context.symmioBuildersNftManager
		nft = context.symmioBuildersNft
		symm = context.symmioToken
		;({ admin, user1: builder, user2: other } = context.signers)
		managerAddress = await manager.getAddress()
		await manager.connect(admin).mintWithoutBurn(builder.address, amount, brand)
	})

	async function pledge(tokenId = 0n, owner = builder) {
		await nft.connect(owner).approve(managerAddress, tokenId)
		return manager.connect(owner).lockNftAsPledge(tokenId)
	}

	async function deployContractBuilder() {
		const contractBuilder = await ethers.deployContract("MockNftPledgeOwner", [managerAddress, await nft.getAddress()])
		await manager.connect(admin).mintWithoutBurn(await contractBuilder.getAddress(), amount, "Contract builder")
		await contractBuilder.pledge(1)
		return contractBuilder
	}

	it("takes custody, records the builder, and preserves lock metadata without moving SYMM", async () => {
		const data = await nft.getLockData(0)
		const supply = await symm.totalSupply()
		const balances = await Promise.all([symm.balanceOf(builder.address), symm.balanceOf(managerAddress), symm.balanceOf(admin.address)])

		await expect(pledge()).to.emit(manager, "NFTLockedAsPledge").withArgs(builder.address, 0, amount)
		expect(await nft.ownerOf(0)).to.equal(managerAddress)
		expect(await manager.pledgeOwners(0)).to.equal(builder.address)
		expect(await nft.getLockData(0)).to.deep.equal(data)
		expect(await nft.getApproved(0)).to.equal(ethers.ZeroAddress)
		expect(await symm.totalSupply()).to.equal(supply)
		expect(await Promise.all([symm.balanceOf(builder.address), symm.balanceOf(managerAddress), symm.balanceOf(admin.address)])).to.deep.equal(
			balances,
		)
	})

	it("requires owner consent even when the caller is approved to transfer the NFT", async () => {
		await nft.connect(builder).approve(other.address, 0)
		await expect(manager.connect(other).lockNftAsPledge(0)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(builder).lockNftAsPledge(0))
			.to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval")
			.withArgs(managerAddress, 0)
		expect(await manager.pledgeOwners(0)).to.equal(ethers.ZeroAddress)
		expect(await nft.ownerOf(0)).to.equal(builder.address)
	})

	it("accepts an owner's blanket approval and prevents pledging an NFT twice", async () => {
		await nft.connect(builder).setApprovalForAll(managerAddress, true)
		await manager.connect(builder).lockNftAsPledge(0)
		await expect(manager.connect(builder).lockNftAsPledge(0)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		expect(await manager.pledgeOwners(0)).to.equal(builder.address)
	})

	it("rejects pending unlocks until cancelled", async () => {
		await manager.connect(builder).initiateUnlock(0, amount / 2n)
		await expect(pledge()).to.be.revertedWithCustomError(manager, "TokenHasActiveUnlock")
		expect(await manager.pledgeOwners(0)).to.equal(ethers.ZeroAddress)
		await manager.connect(builder).cancelUnlock(0)
		await pledge()
		expect(await nft.getEffectiveLockedAmount(0)).to.equal(amount)
	})

	it("leaves already-separated vesting flows claimable while the remaining NFT is pledged", async () => {
		await manager.connect(builder).initiateUnlock(0, amount / 2n)
		await time.increase(Number(await manager.cliffDuration()))
		await manager.connect(builder).completeCliffAndStartVesting(0)
		await expect(pledge())
			.to.emit(manager, "NFTLockedAsPledge")
			.withArgs(builder.address, 0, amount / 2n)
		await manager.connect(admin).slashNftPledge(0, amount / 2n)
		const request = await manager.unlockRequests(0)
		await time.increaseTo(request.vestingEndTime)
		await expect(manager.connect(builder).claimUnlockedToken(request.vestingFlowId)).to.changeTokenBalance(symm, builder, amount / 2n)
		expect(await manager.totalVested()).to.equal(0)
		expect(await manager.userActiveUnlockRequestCount(builder.address)).to.equal(0)
	})

	it("rejects empty and nonexistent NFTs", async () => {
		await nft.connect(admin).updateLockData(0, 0, 0, brand)
		await expect(pledge()).to.be.revertedWithCustomError(manager, "ZeroAmount")
		await expect(manager.connect(builder).lockNftAsPledge(99)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
	})

	it("blocks the builder from transferring, unlocking, increasing, or merging a pledged NFT", async () => {
		await manager.connect(admin).mintWithoutBurn(builder.address, amount, "Other NFT")
		await nft.connect(builder).approve(other.address, 0)
		await pledge()
		await expect(nft.connect(builder).transferFrom(managerAddress, builder.address, 0)).to.be.revertedWithCustomError(
			nft,
			"ERC721InsufficientApproval",
		)
		await expect(nft.connect(other).transferFrom(managerAddress, other.address, 0)).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval")
		await expect(manager.connect(builder).initiateUnlock(0, amount)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(builder).lockIntoNFT(0, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(builder).merge(0, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(builder).merge(1, 0)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
	})

	it("restricts slashing and release to the dedicated role, including grant and revoke", async () => {
		await pledge()
		const role = await manager.PLEDGE_MANAGER_ROLE()
		expect(await manager.hasRole(role, admin.address)).to.equal(true)
		await manager.connect(admin).grantRole(await manager.OPERATOR_ROLE(), other.address)
		for (const caller of [builder, other]) {
			await expect(manager.connect(caller).slashNftPledge(0, 1))
				.to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
				.withArgs(caller.address, role)
			await expect(manager.connect(caller).releaseNftPledge(0))
				.to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
				.withArgs(caller.address, role)
		}
		await manager.connect(admin).grantRole(role, other.address)
		await manager.connect(other).slashNftPledge(0, 1)
		await manager.connect(admin).revokeRole(role, other.address)
		await expect(manager.connect(other).releaseNftPledge(0)).to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
		await manager.connect(admin).grantRole(role, other.address)
		await manager.connect(other).releaseNftPledge(0)
		expect(await nft.ownerOf(0)).to.equal(builder.address)
	})

	it("supports repeated partial slashes, preserves metadata, and moves no SYMM", async () => {
		await pledge()
		const data = await nft.getLockData(0)
		const supply = await symm.totalSupply()
		const slash = amount / 4n
		await expect(manager.connect(admin).slashNftPledge(0, slash))
			.to.emit(manager, "NFTPledgeSlashed")
			.withArgs(builder.address, 0, slash, amount - slash)
		await manager.connect(admin).slashNftPledge(0, slash)
		const remaining = await nft.getLockData(0)
		expect(remaining.amount).to.equal(amount / 2n)
		expect(remaining.unlockingAmount).to.equal(0)
		expect(remaining.lockTimestamp).to.equal(data.lockTimestamp)
		expect(remaining.name).to.equal(brand)
		expect(await nft.ownerOf(0)).to.equal(managerAddress)
		expect(await manager.pledgeOwners(0)).to.equal(builder.address)
		expect(await symm.totalSupply()).to.equal(supply)
		expect(await symm.balanceOf(managerAddress)).to.equal(0)
		expect(await symm.balanceOf(admin.address)).to.equal(0)
		expect(await symm.balanceOf(builder.address)).to.equal(0)
		expect(await manager.totalVested()).to.equal(0)
		expect(await manager.getTokenUnlockIds(0)).to.deep.equal([])
	})

	it("burns a fully slashed NFT and clears its pledge without minting SYMM", async () => {
		await pledge()
		const supply = await symm.totalSupply()
		await expect(manager.connect(admin).slashNftPledge(0, amount)).to.emit(manager, "NFTPledgeSlashed").withArgs(builder.address, 0, amount, 0)
		await expect(nft.ownerOf(0)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
		await expect(nft.getLockData(0)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
		expect(await manager.pledgeOwners(0)).to.equal(ethers.ZeroAddress)
		expect(await symm.totalSupply()).to.equal(supply)
		await expect(manager.connect(admin).releaseNftPledge(0)).to.be.revertedWithCustomError(manager, "NftNotPledged")
		await expect(manager.connect(admin).slashNftPledge(0, 1)).to.be.revertedWithCustomError(manager, "NftNotPledged")
	})

	it("rejects zero slashes, over-slashing, and operations on unpledged NFTs", async () => {
		await expect(manager.connect(admin).slashNftPledge(0, 1)).to.be.revertedWithCustomError(manager, "NftNotPledged")
		await expect(manager.connect(admin).releaseNftPledge(0)).to.be.revertedWithCustomError(manager, "NftNotPledged")
		await pledge()
		await expect(manager.connect(admin).slashNftPledge(0, 0)).to.be.revertedWithCustomError(manager, "ZeroAmount")
		await expect(manager.connect(admin).slashNftPledge(0, amount + 1n)).to.be.revertedWithCustomError(manager, "InsufficientLockedAmount")
		expect((await nft.getLockData(0)).amount).to.equal(amount)
	})

	it("releases the remaining NFT only to its builder and allows unlocking only that remainder", async () => {
		await pledge()
		const slash = amount / 4n
		await manager.connect(admin).slashNftPledge(0, slash)
		await expect(manager.connect(admin).releaseNftPledge(0)).to.emit(manager, "NFTPledgeReleased").withArgs(builder.address, 0)
		expect(await nft.ownerOf(0)).to.equal(builder.address)
		expect(await manager.pledgeOwners(0)).to.equal(ethers.ZeroAddress)
		await expect(manager.connect(admin).releaseNftPledge(0)).to.be.revertedWithCustomError(manager, "NftNotPledged")
		await expect(manager.connect(builder).initiateUnlock(0, amount)).to.be.revertedWithCustomError(manager, "InsufficientLockedAmount")
		await manager.connect(builder).initiateUnlock(0, amount - slash)
		await time.increase(Number(await manager.cliffDuration()))
		await manager.connect(builder).completeCliffAndStartVesting(0)
		const request = await manager.unlockRequests(0)
		await time.increaseTo(request.vestingEndTime)
		await expect(manager.connect(builder).claimUnlockedToken(request.vestingFlowId)).to.changeTokenBalance(symm, builder, amount - slash)
	})

	it("records the new owner if an NFT is pledged again after release and transfer", async () => {
		await pledge()
		await manager.connect(admin).releaseNftPledge(0)
		await nft.connect(builder).transferFrom(builder.address, other.address, 0)
		await pledge(0n, other)
		expect(await manager.pledgeOwners(0)).to.equal(other.address)
		await manager.connect(admin).releaseNftPledge(0)
		expect(await nft.ownerOf(0)).to.equal(other.address)
	})

	it("keeps multiple pledges isolated, including two from the same builder", async () => {
		await manager.connect(admin).mintWithoutBurn(builder.address, amount, "Second")
		await manager.connect(admin).mintWithoutBurn(other.address, amount, "Third")
		await pledge()
		await pledge(1n)
		await pledge(2n, other)
		await manager.connect(admin).slashNftPledge(0, amount)
		await manager.connect(admin).releaseNftPledge(1)
		expect(await nft.ownerOf(1)).to.equal(builder.address)
		expect(await manager.pledgeOwners(2)).to.equal(other.address)
		expect(await nft.ownerOf(2)).to.equal(managerAddress)
		expect((await nft.getLockData(2)).amount).to.equal(amount)
	})

	it("rejects unsolicited safe transfers and fabricated receiver callbacks", async () => {
		await expect(nft.connect(builder)["safeTransferFrom(address,address,uint256)"](builder.address, managerAddress, 0)).to.be.revertedWithCustomError(
			manager,
			"UnexpectedNftTransfer",
		)
		await expect(manager.connect(builder).onERC721Received(managerAddress, builder.address, 0, "0x")).to.be.revertedWithCustomError(
			manager,
			"UnexpectedNftTransfer",
		)
		const foreignProxy = await upgrades.deployProxy(await ethers.getContractFactory("SymmioBuildersNft"), [admin.address])
		const foreign = await ethers.getContractAt("SymmioBuildersNft", await foreignProxy.getAddress())
		await foreign.grantRole(await foreign.MINTER_ROLE(), admin.address)
		await foreign.mint(builder.address, amount, "Foreign NFT")
		await expect(
			foreign.connect(builder)["safeTransferFrom(address,address,uint256)"](builder.address, managerAddress, 0),
		).to.be.revertedWithCustomError(manager, "UnexpectedNftTransfer")
		await expect(nft.connect(admin).mint(managerAddress, amount, "Direct mint")).to.be.revertedWithCustomError(manager, "UnexpectedNftTransfer")
		expect(await nft.ownerOf(0)).to.equal(builder.address)
		expect(await manager.pledgeOwners(0)).to.equal(ethers.ZeroAddress)
	})

	it("pauses all pledge operations and rolls back transfers blocked by the NFT pause", async () => {
		await manager.connect(admin).mintWithoutBurn(builder.address, amount, "Second")
		await pledge()
		await manager.connect(admin).pause()
		await expect(manager.connect(builder).lockNftAsPledge(1)).to.be.revertedWithCustomError(manager, "EnforcedPause")
		await expect(manager.connect(admin).slashNftPledge(0, 1)).to.be.revertedWithCustomError(manager, "EnforcedPause")
		await expect(manager.connect(admin).releaseNftPledge(0)).to.be.revertedWithCustomError(manager, "EnforcedPause")
		await manager.connect(admin).unpause()
		await nft.connect(admin).pauseTransfers()
		await expect(pledge(1n)).to.be.revertedWithCustomError(nft, "TransfersPaused")
		expect(await manager.pledgeOwners(1)).to.equal(ethers.ZeroAddress)
		await expect(manager.connect(admin).releaseNftPledge(0)).to.be.revertedWithCustomError(nft, "TransfersPaused")
		expect(await manager.pledgeOwners(0)).to.equal(builder.address)
		await nft.connect(admin).unpauseTransfers()
		await manager.connect(admin).releaseNftPledge(0)
		expect(await nft.ownerOf(0)).to.equal(builder.address)
	})

	it("rolls back both partial and full slashes when the NFT contract is paused", async () => {
		await pledge()
		await nft.connect(admin).pause()
		await expect(manager.connect(admin).slashNftPledge(0, 1)).to.be.revertedWithCustomError(nft, "EnforcedPause")
		await expect(manager.connect(admin).slashNftPledge(0, amount)).to.be.revertedWithCustomError(nft, "EnforcedPause")
		expect(await manager.pledgeOwners(0)).to.equal(builder.address)
		expect(await nft.ownerOf(0)).to.equal(managerAddress)
		expect((await nft.getLockData(0)).amount).to.equal(amount)
	})

	it("preserves custody when a contract builder rejects release, and supports retry", async () => {
		const contractBuilder = await deployContractBuilder()
		await contractBuilder.setRejectTransfers(true)
		await expect(manager.connect(admin).releaseNftPledge(1)).to.be.revertedWith("NFT rejected")
		expect(await manager.pledgeOwners(1)).to.equal(await contractBuilder.getAddress())
		expect(await nft.ownerOf(1)).to.equal(managerAddress)
		await contractBuilder.setRejectTransfers(false)
		await manager.connect(admin).releaseNftPledge(1)
		expect(await nft.ownerOf(1)).to.equal(await contractBuilder.getAddress())
		expect(await manager.pledgeOwners(1)).to.equal(ethers.ZeroAddress)
	})

	it("blocks reentrancy into unlocking from a contract builder's release callback", async () => {
		const contractBuilder = await deployContractBuilder()
		await contractBuilder.setReentryData(manager.interface.encodeFunctionData("initiateUnlock", [1, amount]))
		await manager.connect(admin).releaseNftPledge(1)
		expect(await contractBuilder.reentrySucceeded()).to.equal(false)
		expect(await contractBuilder.reentryResult()).to.equal(manager.interface.encodeErrorResult("ReentrancyGuardReentrantCall"))
		expect(await manager.getTokenUnlockIds(1)).to.deep.equal([])
		expect(await manager.pledgeOwners(1)).to.equal(ethers.ZeroAddress)
		expect(await nft.ownerOf(1)).to.equal(await contractBuilder.getAddress())
	})
}
