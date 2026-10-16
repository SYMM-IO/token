import { expect } from "chai"
import { ethers, network, upgrades, artifacts } from "hardhat"
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers"
import config from "../configs/carbon-builder-nft-pledge.json"
import baseline from "./fixtures/builder-nft-manager-v1-storage.json"

const forkSuite = process.env.BASE_FORK_RPC_URL ? describe : describe.skip

forkSuite("NFTManager pledges — pinned Base upgrade", function () {
	this.timeout(120000)
	async function fixture() {
		if (network.name !== "hardhat") throw new Error("Fork tests must never run on a live network")
		const managerAddress = ethers.getAddress(config.manager)
		const manager = await ethers.getContractAt("SymmioBuildersNftManager", managerAddress)
		const nft = await ethers.getContractAt("SymmioBuildersNft", config.nft)
		const oldImplementation = await upgrades.erc1967.getImplementationAddress(managerAddress)
		expect(ethers.keccak256(await ethers.provider.getCode(oldImplementation))).to.equal(baseline.runtimeCodeHash)
		expect(await manager.nftContract()).to.equal(config.nft)
		expect(await nft.ownerOf(config.tokenId)).to.equal(config.beneficiary)
		const proxyAdmin = await ethers.getContractAt("ProxyAdmin", await upgrades.erc1967.getAdminAddress(managerAddress))
		const upgradeOwner = await proxyAdmin.owner()
		expect(upgradeOwner).to.equal("0x8CF65060CdA270a3886452A1A1cb656BECEE5bA4")
		const safeContract = new ethers.Contract(
			config.controller,
			["function getThreshold() view returns(uint256)", "function getOwners() view returns(address[])"],
			ethers.provider,
		)
		expect(await safeContract.getThreshold()).to.equal(3n)
		expect(await safeContract.getOwners()).to.have.length(7)
		await impersonateAccount(config.controller)
		await impersonateAccount(config.beneficiary)
		await impersonateAccount(upgradeOwner)
		await setBalance(upgradeOwner, ethers.parseEther("10"))
		await setBalance(config.controller, ethers.parseEther("10"))
		await setBalance(config.beneficiary, ethers.parseEther("10"))
		const safe = await ethers.getSigner(config.controller)
		const carbon = await ethers.getSigner(config.beneficiary)
		const upgrader = await ethers.getSigner(upgradeOwner)
		const configuration = async () =>
			Promise.all([
				manager.SYMM(),
				manager.nftContract(),
				manager.minLockAmount(),
				manager.cliffDuration(),
				manager.vestingDuration(),
				manager.lockedClaimPenaltyRate(),
				manager.lockedClaimPenaltyReceiver(),
				manager.maxUserActiveUnlockRequests(),
				manager.totalVested(),
				manager.userActiveUnlockRequestCount(config.beneficiary),
				manager.getTokenUnlockIds(0),
				manager.getTokenUnlockIds(1),
				manager.unlockRequests(0),
				manager.getUserFlows(config.beneficiary, 0, 100),
				manager.paused(),
				manager.hasRole(await manager.DEFAULT_ADMIN_ROLE(), config.controller),
				nft.getLockData(config.tokenId),
			])
		const before = await configuration()
		const implementation = await (await ethers.getContractFactory("SymmioBuildersNftManager")).deploy()
		await implementation.waitForDeployment()
		const initialization = manager.interface.encodeFunctionData("initializePledges", [config.controller, config.minimumPledgeCollateral])
		await expect(proxyAdmin.connect(carbon).upgradeAndCall(managerAddress, await implementation.getAddress(), initialization)).to.be.reverted
		await expect(proxyAdmin.connect(safe).upgradeAndCall(managerAddress, await implementation.getAddress(), initialization)).to.be.reverted
		await proxyAdmin.connect(upgrader).upgradeAndCall(managerAddress, await implementation.getAddress(), initialization)
		expect(await configuration()).to.deep.equal(before)
		expect(await manager.pledgeController()).to.equal(config.controller)
		expect(await manager.minimumPledgeCollateral()).to.equal(BigInt(config.minimumPledgeCollateral))
		expect(await manager.version()).to.equal("1.1.0")
		const artifact = await artifacts.readArtifact("SymmioBuildersNftManager")
		expect(await ethers.provider.getCode(await upgrades.erc1967.getImplementationAddress(managerAddress))).to.equal(artifact.deployedBytecode)
		return { manager, nft, proxyAdmin, safe, carbon, managerAddress }
	}

	async function depositFixture() {
		const f = await loadFixture(fixture)
		await f.nft.connect(f.carbon).approve(f.managerAddress, config.tokenId)
		await f.manager.connect(f.carbon).lockNftAsPledgeForSymmio(config.tokenId)
		return f
	}

	it("upgrades the actual manager atomically through its existing upgrade owner without changing V1 state", async () => {
		const { manager, carbon } = await loadFixture(fixture)
		await expect(manager.connect(carbon).initializePledges(config.beneficiary, 1)).to.be.revertedWithCustomError(manager, "InvalidInitialization")
		expect(await manager.isPledgedNftInCustody(config.tokenId)).to.equal(false)
	})

	it("pledges the actual NFT without a Safe approval transaction and permits immediate Safe-only return", async () => {
		const { manager, nft, carbon, safe, managerAddress } = await loadFixture(depositFixture)
		expect(await nft.ownerOf(config.tokenId)).to.equal(managerAddress)
		expect((await manager.nftPledges(config.tokenId)).collateralAmount).to.be.at.least(BigInt(config.minimumPledgeCollateral))
		await expect(manager.connect(carbon).initiateUnlock(config.tokenId, 1)).to.be.revertedWithCustomError(manager, "NotTokenOwner")
		await expect(manager.connect(carbon).releasePledgedNft(config.tokenId)).to.be.revertedWithCustomError(manager, "UnauthorizedPledgeController")
		await expect(nft.connect(carbon).transferFrom(managerAddress, config.beneficiary, config.tokenId)).to.be.reverted
		await manager.connect(safe).releasePledgedNft(config.tokenId)
		expect(await nft.ownerOf(config.tokenId)).to.equal(config.beneficiary)
	})

	it("seizes the entire NFT into the actual Safe without redeeming or reducing represented SYMM", async () => {
		const { manager, nft, safe } = await loadFixture(depositFixture)
		const before = await nft.getLockData(config.tokenId)
		await manager.connect(safe).seizePledgedNft(config.tokenId)
		expect(await nft.ownerOf(config.tokenId)).to.equal(config.controller)
		expect(await nft.getLockData(config.tokenId)).to.deep.equal(before)
		expect((await manager.nftPledges(config.tokenId)).settlementRecipient).to.equal(config.controller)
	})

	for (const settlement of ["releasePledgedNft", "seizePledgedNft"] as const) {
		it(`partially seizes into a new actual Builder NFT, then settles the remainder with ${settlement}`, async () => {
			const { manager, nft, safe, carbon, managerAddress } = await loadFixture(depositFixture)
			const original = await nft.getLockData(config.tokenId)
			const amount = ethers.parseEther("1000000")
			const symm = await ethers.getContractAt("IERC20", await manager.SYMM())
			const supply = await symm.totalSupply()
			await expect(manager.connect(carbon).partiallySeizePledgedNft(config.tokenId, amount)).to.be.revertedWithCustomError(
				manager,
				"UnauthorizedPledgeController",
			)
			const seizedId = await manager.connect(safe).partiallySeizePledgedNft.staticCall(config.tokenId, amount)
			await expect(manager.connect(safe).partiallySeizePledgedNft(config.tokenId, amount))
				.to.emit(manager, "PledgedNftPartiallySeized")
				.withArgs(config.tokenId, seizedId, config.controller, amount, original.amount - amount)
			expect(await nft.ownerOf(seizedId)).to.equal(config.controller)
			expect(await nft.ownerOf(config.tokenId)).to.equal(managerAddress)
			expect((await nft.getLockData(config.tokenId)).amount + (await nft.getLockData(seizedId)).amount).to.equal(original.amount)
			expect((await nft.getLockData(config.tokenId)).lockTimestamp).to.equal(original.lockTimestamp)
			expect(await manager.partiallySeizedCollateral(config.tokenId)).to.equal(amount)
			expect((await manager.nftPledges(config.tokenId)).status).to.equal(1)
			expect(await symm.totalSupply()).to.equal(supply)
			await manager.connect(safe)[settlement](config.tokenId)
			expect(await nft.ownerOf(config.tokenId)).to.equal(settlement === "releasePledgedNft" ? config.beneficiary : config.controller)
			expect((await nft.getLockData(config.tokenId)).amount).to.equal(original.amount - amount)
		})
	}
})
