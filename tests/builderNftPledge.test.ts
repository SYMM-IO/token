import { expect } from "chai"
import hre, { ethers, upgrades, network } from "hardhat"
import { loadFixture, time, impersonateAccount, setBalance, stopImpersonatingAccount } from "@nomicfoundation/hardhat-network-helpers"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import type { StorageLayout } from "@openzeppelin/upgrades-core/dist/storage/layout"
import { getDeployData } from "@openzeppelin/hardhat-upgrades/dist/utils/deploy-impl"
import baseline from "./fixtures/builder-nft-manager-v1-storage.json"
import { initializeFixture } from "./Initialize.fixture"

const MINIMUM = ethers.parseEther("8800000")
const ID = 1n

async function baseFixture() {
	if (network.name !== "hardhat") throw new Error("Pledge tests run locally only")
	const context = await initializeFixture()
	const { symmioBuildersNftManager: manager, symmioBuildersNft: nft, symmioToken: symm } = context
	const { admin, user1: carbon, user2: stranger } = context.signers
	const safe = (await ethers.getSigners())[8]
	await manager.mintWithoutBurn(stranger.address, MINIMUM, "Other")
	await manager.mintWithoutBurn(carbon.address, MINIMUM, "IntentX")
	const address = await manager.getAddress()
	return { context, manager, nft, symm, admin, carbon, stranger, safe, address }
}

async function fixture() {
	const f = await baseFixture()
	await f.manager.initializePledges(f.safe.address)
	await f.manager.connect(f.safe).configureNftPledge(ID, f.carbon.address, MINIMUM)
	const deposit = async () => {
		await f.nft.connect(f.carbon).approve(f.address, ID)
		return f.manager.connect(f.carbon).lockNftAsPledgeForSymmio(ID)
	}
	return { ...f, deposit }
}

describe("NFTManager SYMMIO pledges", () => {
	it("validates implementation safety and append-only storage against the saved develop layout", async () => {
		const factory = await ethers.getContractFactory("SymmioBuildersNftManager")
		await upgrades.validateImplementation(factory, { kind: "transparent" })
		const data = await getDeployData(hre, factory, { kind: "transparent" })
		assertStorageUpgradeSafe(baseline.layout as StorageLayout, data.layout, data.fullOpts)
	})

	it("enables pledges only once through an authorized manager administrator", async () => {
		const { manager, stranger, safe, address } = await loadFixture(baseFixture)
		expect(await manager.pledgeController()).to.equal(ethers.ZeroAddress)
		await expect(manager.connect(stranger).initializePledges(safe.address)).to.be.revertedWithCustomError(manager, "UnauthorizedPledgeController")
		for (const invalid of [ethers.ZeroAddress, address]) {
			await expect(manager.initializePledges(invalid)).to.be.revertedWithCustomError(manager, "InvalidPledgeConfiguration")
		}
		await expect(manager.initializePledges(safe.address)).to.emit(manager, "PledgeControllerInitialized").withArgs(safe.address)
		await expect(manager.initializePledges(stranger.address)).to.be.revertedWithCustomError(manager, "InvalidInitialization")
		const implementation = await ethers.getContractAt("SymmioBuildersNftManager", await upgrades.erc1967.getImplementationAddress(address))
		await expect(implementation.initializePledges(safe.address)).to.be.revertedWithCustomError(implementation, "InvalidInitialization")
	})

	it("only allows the configured Safe to approve each NFT and fixes its terms", async () => {
		const { manager, admin, stranger, safe, carbon, address } = await loadFixture(fixture)
		for (const actor of [admin, stranger, carbon]) {
			await expect(manager.connect(actor).configureNftPledge(0, stranger.address, 1)).to.be.revertedWithCustomError(
				manager,
				"UnauthorizedPledgeController",
			)
		}
		for (const beneficiary of [ethers.ZeroAddress, address, safe.address]) {
			await expect(manager.connect(safe).configureNftPledge(0, beneficiary, 1)).to.be.revertedWithCustomError(manager, "InvalidPledgeConfiguration")
		}
		await expect(manager.connect(safe).configureNftPledge(0, stranger.address, 0)).to.be.revertedWithCustomError(
			manager,
			"InvalidPledgeConfiguration",
		)
		await expect(manager.connect(safe).configureNftPledge(0, carbon.address, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(safe).configureNftPledge(ID, carbon.address, MINIMUM)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
	})

	it("takes approved custody, preserves the beneficiary and clears NFT approvals", async () => {
		const { manager, nft, carbon, address, deposit } = await loadFixture(fixture)
		await expect(deposit()).to.emit(manager, "NftPledged").withArgs(ID, carbon.address, MINIMUM)
		expect(await nft.ownerOf(ID)).to.equal(address)
		expect(await nft.getApproved(ID)).to.equal(ethers.ZeroAddress)
		expect(await manager.isPledgedNftInCustody(ID)).to.equal(true)
		const p = await manager.nftPledges(ID)
		expect(p.beneficiary).to.equal(carbon.address)
		expect(p.collateralAmount).to.equal(MINIMUM)
		expect(p.status).to.equal(2)
		expect(await manager.totalVested()).to.equal(0)
	})

	it("requires Safe approval, owner initiation and NFT approval", async () => {
		const { manager, nft, carbon, stranger, address } = await loadFixture(fixture)
		await expect(manager.connect(stranger).lockNftAsPledgeForSymmio(0)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		await nft.connect(carbon).approve(stranger.address, ID)
		await expect(manager.connect(stranger).lockNftAsPledgeForSymmio(ID)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(carbon).lockNftAsPledgeForSymmio(ID)).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval")
		expect((await manager.nftPledges(ID)).status).to.equal(1)
		await nft.connect(carbon).transferFrom(carbon.address, stranger.address, ID)
		await nft.connect(stranger).approve(address, ID)
		await expect(manager.connect(carbon).lockNftAsPledgeForSymmio(ID)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(stranger).lockNftAsPledgeForSymmio(ID)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
	})

	it("rejects insufficient collateral and snapshots amounts above the minimum", async () => {
		const { manager, nft, carbon, deposit } = await loadFixture(fixture)
		await nft.updateLockData(ID, MINIMUM - 1n, 0, "IntentX")
		await expect(deposit())
			.to.be.revertedWithCustomError(manager, "AmountBelowMinimum")
			.withArgs(MINIMUM - 1n, MINIMUM)
		expect(await nft.ownerOf(ID)).to.equal(carbon.address)
		await nft.updateLockData(ID, MINIMUM + 1n, 0, "IntentX")
		await deposit()
		expect((await manager.nftPledges(ID)).collateralAmount).to.equal(MINIMUM + 1n)
	})

	it("rejects pending unlocks without altering existing unlock accounting", async () => {
		const { manager, nft, carbon, deposit } = await loadFixture(fixture)
		await manager.connect(carbon).initiateUnlock(ID, 1)
		const before = await manager.unlockRequests(0)
		await expect(deposit()).to.be.revertedWithCustomError(manager, "TokenHasActiveUnlock")
		expect(await manager.unlockRequests(0)).to.deep.equal(before)
		expect(await nft.ownerOf(ID)).to.equal(carbon.address)
		await manager.connect(carbon).cancelUnlock(0)
		await deposit()
	})

	it("rejects unsolicited safe transfers and forged callbacks", async () => {
		const { manager, nft, carbon, address } = await loadFixture(fixture)
		await expect(nft.connect(carbon)["safeTransferFrom(address,address,uint256)"](carbon.address, address, ID)).to.be.revertedWithCustomError(
			manager,
			"InvalidPledgeTransfer",
		)
		await expect(manager.onERC721Received(address, carbon.address, ID, "0x")).to.be.revertedWithCustomError(manager, "InvalidPledgeTransfer")
		const nftAddress = await nft.getAddress()
		await impersonateAccount(nftAddress)
		await setBalance(nftAddress, ethers.parseEther("1"))
		await expect(
			manager.connect(await ethers.getSigner(nftAddress)).onERC721Received(address, carbon.address, ID, "0x"),
		).to.be.revertedWithCustomError(manager, "InvalidPledgeTransfer")
		await stopImpersonatingAccount(nftAddress)
	})

	it("registers a configured ordinary transfer permissionlessly without changing its beneficiary", async () => {
		const { manager, nft, carbon, stranger, address } = await loadFixture(fixture)
		await expect(manager.recordNftPledge(ID)).to.be.revertedWithCustomError(manager, "PledgeNotInCustody")
		await nft.connect(carbon).transferFrom(carbon.address, address, ID)
		expect((await manager.nftPledges(ID)).status).to.equal(1)
		await expect(manager.connect(stranger).recordNftPledge(ID)).to.emit(manager, "NftPledged").withArgs(ID, carbon.address, MINIMUM)
		await expect(manager.recordNftPledge(ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
	})

	it("checks pending unlocks and minimum collateral on ordinary-transfer registration", async () => {
		const { manager, nft, carbon, address } = await loadFixture(fixture)
		await nft.connect(carbon).transferFrom(carbon.address, address, ID)
		await nft.updateLockData(ID, MINIMUM, 1, "IntentX")
		await expect(manager.recordNftPledge(ID)).to.be.revertedWithCustomError(manager, "TokenHasActiveUnlock")
		await nft.updateLockData(ID, MINIMUM - 1n, 0, "IntentX")
		await expect(manager.recordNftPledge(ID)).to.be.revertedWithCustomError(manager, "AmountBelowMinimum")
	})

	it("cannot register an unapproved raw deposit and recovers it only to the Safe", async () => {
		const { manager, nft, stranger, safe, address } = await loadFixture(fixture)
		await nft.connect(stranger).transferFrom(stranger.address, address, 0)
		await expect(manager.recordNftPledge(0)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		await expect(manager.connect(safe).returnUnregisteredPledgedNft(0)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		await manager.connect(safe).recoverUnrelatedPledgeNft(await nft.getAddress(), 0)
		expect(await nft.ownerOf(0)).to.equal(safe.address)
		expect((await manager.nftPledges(0)).status).to.equal(0)
	})

	it("supports independently approved NFTs with different owners and thresholds", async () => {
		const { manager, nft, stranger, safe, carbon, address, deposit } = await loadFixture(fixture)
		await manager.connect(safe).configureNftPledge(0, stranger.address, 123n)
		await nft.connect(stranger).approve(address, 0)
		await manager.connect(stranger).lockNftAsPledgeForSymmio(0)
		await deposit()
		await manager.connect(safe).releasePledgedNft(0)
		expect(await nft.ownerOf(0)).to.equal(stranger.address)
		expect(await nft.ownerOf(ID)).to.equal(address)
		expect((await manager.nftPledges(ID)).beneficiary).to.equal(carbon.address)
	})

	it("prevents the depositor or operators from transferring, merging or unlocking pledged collateral", async () => {
		const { manager, nft, carbon, stranger, address, deposit } = await loadFixture(fixture)
		await deposit()
		await nft.connect(stranger).transferFrom(stranger.address, carbon.address, 0)
		await expect(nft.connect(carbon).transferFrom(address, carbon.address, ID)).to.be.reverted
		await expect(nft.connect(carbon).approve(stranger.address, ID)).to.be.reverted
		await expect(manager.connect(carbon).initiateUnlock(ID, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(carbon).merge(0, ID)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(carbon).merge(ID, 0)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(carbon).lockIntoNFT(ID, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
	})

	for (const action of ["releasePledgedNft", "seizePledgedNft"] as const) {
		it(`restricts ${action} to the Safe and settles immediately to the fixed recipient`, async () => {
			const { manager, nft, admin, carbon, stranger, safe, deposit } = await loadFixture(fixture)
			await expect(manager.connect(safe)[action](ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
			await deposit()
			for (const actor of [admin, carbon, stranger])
				await expect(manager.connect(actor)[action](ID)).to.be.revertedWithCustomError(manager, "UnauthorizedPledgeController")
			const released = action === "releasePledgedNft"
			const recipient = released ? carbon.address : safe.address
			const dataBefore = await nft.getLockData(ID)
			await expect(manager.connect(safe)[action](ID))
				.to.emit(manager, released ? "PledgedNftReleased" : "PledgedNftSeized")
				.withArgs(ID, recipient)
			expect(await nft.ownerOf(ID)).to.equal(recipient)
			expect(await nft.getLockData(ID)).to.deep.equal(dataBefore)
			const p = await manager.nftPledges(ID)
			expect(p.status).to.equal(released ? 3 : 4)
			expect(p.settlementRecipient).to.equal(recipient)
			expect(await manager.isPledgedNftInCustody(ID)).to.equal(false)
			for (const repeat of ["releasePledgedNft", "seizePledgedNft"] as const)
				await expect(manager.connect(safe)[repeat](ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		})

		it(`rolls back ${action} on NFT transfer failure and allows retry`, async () => {
			const { manager, nft, safe, address, deposit } = await loadFixture(fixture)
			await deposit()
			await nft.pauseTransfers()
			await expect(manager.connect(safe)[action](ID)).to.be.revertedWithCustomError(nft, "TransfersPaused")
			expect((await manager.nftPledges(ID)).status).to.equal(2)
			expect((await manager.nftPledges(ID)).settlementRecipient).to.equal(ethers.ZeroAddress)
			expect(await nft.ownerOf(ID)).to.equal(address)
			await nft.unpauseTransfers()
			await manager.connect(safe)[action](ID)
		})

		it(`recovers raw resends after ${action} only to the recorded recipient`, async () => {
			const { manager, nft, carbon, stranger, safe, address, deposit } = await loadFixture(fixture)
			await deposit()
			await manager.connect(safe)[action](ID)
			const recipient = action === "releasePledgedNft" ? carbon : safe
			await nft.connect(recipient).transferFrom(recipient.address, address, ID)
			await expect(manager.recordNftPledge(ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
			await expect(manager.connect(stranger).recoverSettledPledgedNft(ID)).to.be.revertedWithCustomError(manager, "UnauthorizedPledgeController")
			await manager.connect(safe).recoverSettledPledgedNft(ID)
			expect(await nft.ownerOf(ID)).to.equal(recipient.address)
			await expect(manager.connect(safe).configureNftPledge(ID, carbon.address, 1)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		})
	}

	it("respects manager and NFT pauses during entry and settlement", async () => {
		const { manager, nft, safe, deposit } = await loadFixture(fixture)
		await manager.pause()
		await expect(deposit()).to.be.revertedWithCustomError(manager, "EnforcedPause")
		await manager.unpause()
		await nft.pauseTransfers()
		await expect(deposit()).to.be.revertedWithCustomError(nft, "TransfersPaused")
		expect((await manager.nftPledges(ID)).status).to.equal(1)
		await nft.unpauseTransfers()
		await deposit()
		await manager.pause()
		await expect(manager.connect(safe).releasePledgedNft(ID)).to.be.revertedWithCustomError(manager, "EnforcedPause")
		await manager.unpause()
		await manager.connect(safe).releasePledgedNft(ID)
	})

	it("returns invalid ordinary deposits to the preapproved owner and closes their lifecycle", async () => {
		const { manager, nft, carbon, stranger, safe, address } = await loadFixture(fixture)
		await nft.updateLockData(ID, 1, 0, "IntentX")
		await nft.connect(carbon).transferFrom(carbon.address, address, ID)
		await expect(manager.connect(stranger).returnUnregisteredPledgedNft(ID)).to.be.revertedWithCustomError(manager, "UnauthorizedPledgeController")
		await manager.connect(safe).returnUnregisteredPledgedNft(ID)
		expect(await nft.ownerOf(ID)).to.equal(carbon.address)
		expect((await manager.nftPledges(ID)).status).to.equal(3)
		expect((await manager.nftPledges(ID)).collateralAmount).to.equal(0)
	})

	it("cannot bypass locked collateral through recovery routes", async () => {
		const { manager, nft, safe, deposit } = await loadFixture(fixture)
		await deposit()
		await expect(manager.connect(safe).returnUnregisteredPledgedNft(ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		await expect(manager.connect(safe).recoverSettledPledgedNft(ID)).to.be.revertedWithCustomError(manager, "InvalidPledgeStatus")
		await expect(manager.connect(safe).recoverUnrelatedPledgeNft(await nft.getAddress(), ID)).to.be.revertedWithCustomError(
			manager,
			"ProtectedPledgeNFT",
		)
	})

	it("recovers unrelated NFT collections only to the Safe", async () => {
		const { manager, admin, carbon, stranger, safe, address } = await loadFixture(fixture)
		const proxy = await upgrades.deployProxy(await ethers.getContractFactory("SymmioBuildersNft"), [admin.address])
		const other = await ethers.getContractAt("SymmioBuildersNft", await proxy.getAddress())
		await other.grantRole(await other.MINTER_ROLE(), admin.address)
		await other.mint(carbon.address, 1, "Other")
		await expect(other.connect(carbon)["safeTransferFrom(address,address,uint256)"](carbon.address, address, 0)).to.be.revertedWithCustomError(
			manager,
			"InvalidPledgeTransfer",
		)
		await other.connect(carbon).transferFrom(carbon.address, address, 0)
		await expect(manager.connect(stranger).recoverUnrelatedPledgeNft(await other.getAddress(), 0)).to.be.revertedWithCustomError(
			manager,
			"UnauthorizedPledgeController",
		)
		await manager.connect(safe).recoverUnrelatedPledgeNft(await other.getAddress(), 0)
		expect(await other.ownerOf(0)).to.equal(safe.address)
	})

	it("reports actual missing custody after privileged NFT burn", async () => {
		const { manager, nft, safe, deposit } = await loadFixture(fixture)
		await deposit()
		await nft.burn(ID)
		expect(await manager.isPledgedNftInCustody(ID)).to.equal(false)
		await expect(manager.connect(safe).seizePledgedNft(ID)).to.be.revertedWithCustomError(manager, "PledgeNotInCustody")
	})

	it("keeps preexisting vesting entitlements separate from the pledged remainder", async () => {
		const { manager, nft, symm, carbon, safe, deposit } = await loadFixture(fixture)
		const vesting = ethers.parseEther("100")
		await nft.updateLockData(ID, MINIMUM + vesting, 0, "IntentX")
		await manager.connect(carbon).initiateUnlock(ID, vesting)
		await time.increase(Number(await manager.cliffDuration()) + 1)
		await manager.connect(carbon).completeCliffAndStartVesting(0)
		const request = await manager.unlockRequests(0)
		await deposit()
		expect(await manager.totalVested()).to.equal(vesting)
		await manager.connect(safe).seizePledgedNft(ID)
		await time.increaseTo(request.vestingEndTime + 1n)
		const balance = await symm.balanceOf(carbon.address)
		await manager.connect(carbon).claimUnlockedToken(request.vestingFlowId)
		expect(await symm.balanceOf(carbon.address)).to.equal(balance + vesting)
		expect(await manager.totalVested()).to.equal(0)
		expect((await nft.getLockData(ID)).amount).to.equal(MINIMUM)
	})

	it("rolls back a release rejected by the beneficiary", async () => {
		const { manager, nft, carbon, safe, address } = await loadFixture(baseFixture)
		const receiver = await (await ethers.getContractFactory("PledgeReceiverMock")).deploy()
		const beneficiary = await receiver.getAddress()
		await manager.initializePledges(safe.address)
		await nft.connect(carbon).transferFrom(carbon.address, beneficiary, ID)
		await manager.connect(safe).configureNftPledge(ID, beneficiary, MINIMUM)
		await receiver.execute(await nft.getAddress(), nft.interface.encodeFunctionData("approve", [address, ID]))
		await receiver.execute(address, manager.interface.encodeFunctionData("lockNftAsPledgeForSymmio", [ID]))
		await receiver.configure(true, ethers.ZeroAddress, "0x")
		await expect(manager.connect(safe).releasePledgedNft(ID)).to.be.revertedWith("Receiver rejects NFT")
		expect((await manager.nftPledges(ID)).status).to.equal(2)
		expect(await nft.ownerOf(ID)).to.equal(address)
	})

	it("blocks authorized controller reentrancy during seizure", async () => {
		const { manager, nft, carbon, address } = await loadFixture(baseFixture)
		const receiver = await (await ethers.getContractFactory("PledgeReceiverMock")).deploy()
		await manager.initializePledges(await receiver.getAddress())
		await receiver.execute(address, manager.interface.encodeFunctionData("configureNftPledge", [ID, carbon.address, MINIMUM]))
		await nft.connect(carbon).approve(address, ID)
		await manager.connect(carbon).lockNftAsPledgeForSymmio(ID)
		await receiver.configure(false, address, manager.interface.encodeFunctionData("releasePledgedNft", [ID]))
		await receiver.execute(address, manager.interface.encodeFunctionData("seizePledgedNft", [ID]))
		expect(await receiver.reentrySucceeded()).to.equal(false)
		expect(await receiver.reentryResult()).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10))
		expect((await manager.nftPledges(ID)).status).to.equal(4)
	})

	for (const state of ["locked", "released", "seized"] as const) {
		it(`preserves ${state} pledge state and custody through a compatible future upgrade`, async () => {
			const { manager, nft, carbon, safe, address, deposit } = await loadFixture(fixture)
			await deposit()
			if (state === "released") await manager.connect(safe).releasePledgedNft(ID)
			if (state === "seized") await manager.connect(safe).seizePledgedNft(ID)
			const before = await manager.nftPledges(ID)
			const owner = await nft.ownerOf(ID)
			const factory = await ethers.getContractFactory("BuilderNftManagerPledgeVNextMock")
			await upgrades.validateUpgrade(await ethers.getContractFactory("SymmioBuildersNftManager"), factory, { kind: "transparent" })
			await upgrades.upgradeProxy(address, factory)
			expect(await manager.nftPledges(ID)).to.deep.equal(before)
			expect(await nft.ownerOf(ID)).to.equal(owner)
			expect(await manager.pledgeController()).to.equal(safe.address)
			if (state === "locked") {
				await manager.connect(safe).releasePledgedNft(ID)
				expect(await nft.ownerOf(ID)).to.equal(carbon.address)
			}
		})
	}
})
