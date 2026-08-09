import type { HardhatEthersSigner as SignerWithAddress } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"

import { SymmioBuildersNft } from "../typechain-types/index.js"
import { initializeFixture, RunContext } from "./Initialize.fixture.js"
import { ethers, networkHelpers } from "./hardhat.js"

const { loadFixture } = networkHelpers

function interfaceId(signatures: string[]): string {
	let id = 0n
	for (const signature of signatures) id ^= BigInt(ethers.id(signature).slice(0, 10))
	return ethers.toBeHex(id, 4)
}

export function shouldBehaveLikeSymmioBuildersNft() {
	let context: RunContext
	let nft: SymmioBuildersNft
	let admin: SignerWithAddress
	let user1: SignerWithAddress
	let user2: SignerWithAddress

	const amount = ethers.parseEther("100")
	const brand = "Builder"

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		nft = context.symmioBuildersNft
		;({ admin, user1, user2 } = context.signers)
	})

	async function mint(to = user1.address, value = amount, name = brand): Promise<bigint> {
		await expect(nft.connect(admin).mint(to, value, name))
			.to.emit(nft, "NFTMinted")
			.withArgs(to, 0, value, name)
		return 0n
	}

	describe("minting and lock data", () => {
		it("mints an enumerable NFT with the expected lock data", async () => {
			const tokenId = await mint()
			const data = await nft.getLockData(tokenId)

			expect(await nft.ownerOf(tokenId)).to.equal(user1.address)
			expect(await nft.getUserTokenIds(user1.address)).to.deep.equal([tokenId])
			expect(data.amount).to.equal(amount)
			expect(data.unlockingAmount).to.equal(0)
			expect(data.name).to.equal(brand)
			expect(data.lockTimestamp).to.be.greaterThan(0)
		})

		it("restricts minting to MINTER_ROLE", async () => {
			await expect(nft.connect(user1).mint(user1.address, amount, brand))
				.to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
				.withArgs(user1.address, await nft.MINTER_ROLE())
		})

		it("updates lock data while preserving its original timestamp", async () => {
			const tokenId = await mint()
			const before = await nft.getLockData(tokenId)
			const newAmount = ethers.parseEther("150")
			const unlockingAmount = ethers.parseEther("25")

			await expect(nft.connect(admin).updateLockData(tokenId, newAmount, unlockingAmount, "Updated"))
				.to.emit(nft, "LockDataUpdated")
				.withArgs(tokenId, newAmount, unlockingAmount, "Updated")

			const after = await nft.getLockData(tokenId)
			expect(after.amount).to.equal(newAmount)
			expect(after.unlockingAmount).to.equal(unlockingAmount)
			expect(after.name).to.equal("Updated")
			expect(after.lockTimestamp).to.equal(before.lockTimestamp)
		})

		it("rejects invalid or unauthorized lock-data updates", async () => {
			const tokenId = await mint()
			await expect(nft.connect(admin).updateLockData(tokenId, 1, 2, brand)).to.be.revertedWithCustomError(nft, "InvalidLockData")
			await expect(nft.connect(user1).updateLockData(tokenId, amount, 0, brand))
				.to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
				.withArgs(user1.address, await nft.MINTER_ROLE())
		})

		it("burns an NFT and removes its lock data", async () => {
			const tokenId = await mint()
			await nft.connect(admin).burn(tokenId)

			await expect(nft.ownerOf(tokenId)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
			await expect(nft.getLockData(tokenId)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
		})
	})

	describe("transfers and pause controls", () => {
		it("blocks transfers while a token has an active unlock", async () => {
			const tokenId = await mint()
			await nft.connect(admin).updateLockData(tokenId, amount, ethers.parseEther("1"), brand)

			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)).to.be.revertedWithCustomError(nft, "TokenHasActiveUnlock")
		})

		it("supports an independent transfer pause", async () => {
			const tokenId = await mint()
			await nft.connect(admin).pauseTransfers()
			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)).to.be.revertedWithCustomError(nft, "TransfersPaused")

			await nft.connect(admin).unpauseTransfers()
			await nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)
			expect(await nft.ownerOf(tokenId)).to.equal(user2.address)
		})

		it("globally pauses minting, burning, updates, and transfers", async () => {
			const tokenId = await mint()
			await nft.connect(admin).pause()
			expect(await nft.paused()).to.equal(true)

			await expect(nft.connect(admin).mint(user2.address, amount, brand)).to.be.revertedWithCustomError(nft, "EnforcedPause")
			await expect(nft.connect(admin).burn(tokenId)).to.be.revertedWithCustomError(nft, "EnforcedPause")
			await expect(nft.connect(admin).updateLockData(tokenId, amount, 0, brand)).to.be.revertedWithCustomError(nft, "EnforcedPause")
			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)).to.be.revertedWithCustomError(nft, "TransfersPaused")

			await nft.connect(admin).unpause()
			await nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)
			expect(await nft.ownerOf(tokenId)).to.equal(user2.address)
		})

		it("does not clear an independent transfer pause when globally unpaused", async () => {
			const tokenId = await mint()
			await nft.connect(admin).pauseTransfers()
			await nft.connect(admin).pause()
			await nft.connect(admin).unpause()

			expect(await nft.transfersPaused()).to.equal(true)
			await expect(nft.connect(user1).transferFrom(user1.address, user2.address, tokenId)).to.be.revertedWithCustomError(nft, "TransfersPaused")
		})
	})

	describe("ERC-165", () => {
		it("advertises the complete ISymmioBuildersNft interface", async () => {
			const buildersInterfaceId = interfaceId([
				"mint(address,uint256,string)",
				"burn(uint256)",
				"getLockData(uint256)",
				"updateLockData(uint256,uint256,uint256,string)",
				"pause()",
				"unpause()",
				"paused()",
			])

			expect(await nft.supportsInterface(buildersInterfaceId)).to.equal(true)
			expect(await nft.supportsInterface("0xffffffff")).to.equal(false)
		})
	})
}
