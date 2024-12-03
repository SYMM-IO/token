import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { SymmAllocationClaimer, Symmio } from "../typechain-types"
import { initializeFixture, RunContext } from "./Initialize.fixture"
import { e } from "../utils"

export function shouldBehaveLikeSymmAllocationClaimer() {
	let context: RunContext
	let symmClaim: SymmAllocationClaimer
	let symmToken: Symmio

	const ROLES = {
		DEFAULT_ADMIN: "DEFAULT_ADMIN_ROLE",
		BALANCER: "SETTER_ROLE",
		PAUSER: "PAUSER_ROLE",
		SETTER: "MINTER_ROLE",
		UNPAUSER: "UNPAUSER_ROLE",
	} as const

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		symmClaim = context.claimSymm
		symmToken = context.symmioToken
	})

	describe("Deployment", () => {
		it("should deploy successfully", async () => {
			expect(await symmClaim.getAddress()).to.be.properAddress
		})

		it("should grant roles correctly", async () => {
			for (const role of Object.values(ROLES)) {
				const hasRole = await symmClaim.hasRole(await symmClaim[role](), await context.signers.admin.getAddress())
				expect(hasRole).to.be.true
			}
		})
	})

	describe("Config", () => {
		it("should (un)pause correctly", async () => {
			expect(await symmClaim.paused()).to.be.false
			await symmClaim.connect(context.signers.admin).pause()
			expect(await symmClaim.paused()).to.be.true
			await symmClaim.connect(context.signers.admin).unpause()
			expect(await symmClaim.paused()).to.be.false
		})
	})

	describe("Setting Allocations", () => {
		it("should set batch allocations correctly", async () => {
			const users = [context.signers.user1.address, context.signers.user2.address]
			const allocations = [e(1000), e(2000)] // Allocations in 18 decimals

			await symmClaim.connect(context.signers.setter).setBatchAllocations(users, allocations)

			expect(await symmClaim.userAllocations(context.signers.user1.address)).to.equal(e(1000))
			expect(await symmClaim.userAllocations(context.signers.user2.address)).to.equal(e(2000))
			expect(await symmClaim.totalAllocation()).to.equal(e(3000))
		})

		it("should revert if total allocation exceeds max issuable tokens", async () => {
			const users = [context.signers.user1.address]
			const allocations = [e(401000000)] // Exceeds MAX_ISSUABLE_TOKEN

			await expect(symmClaim.connect(context.signers.setter).setBatchAllocations(users, allocations)).to.be.revertedWithCustomError(
				symmClaim,
				"TotalAllocationExceedsMax",
			)
		})
	})

	describe("Claiming Allocations", () => {
		beforeEach(async () => {
			const users = [context.signers.user1.address]
			const allocations = [e(1000)]
			await symmClaim.connect(context.signers.setter).setBatchAllocations(users, allocations)
		})

		it("should allow a user to claim their allocation", async () => {
			const user1InitialBalance = await symmToken.balanceOf(context.signers.user1.address)
			await symmClaim.connect(context.signers.user1).claim()

			const user1FinalBalance = await symmToken.balanceOf(context.signers.user1.address)
			expect(user1FinalBalance - user1InitialBalance).to.equal(e(500)) // Adjust for mintFactor

			expect(await symmClaim.userAllocations(context.signers.user1.address)).to.equal(e(0))
			expect(await symmClaim.totalAllocation()).to.equal(e(1000))
		})

		it("should revert if a user has no allocation", async () => {
			await expect(symmClaim.connect(context.signers.user2).claim()).to.be.revertedWithCustomError(symmClaim, "UserHasNoAllocation")
		})
	})

	describe("Admin Claims", () => {
		it("should allow admin to claim tokens", async () => {
			const users = [context.signers.user1.address]
			const allocations = [e(1000)]
			await symmClaim.connect(context.signers.setter).setBatchAllocations(users, allocations)
			await symmClaim.connect(context.signers.user1).claim()

			await symmClaim.connect(context.signers.admin).adminClaim(e(500)) // Admin claims tokens
			const foundationBalance = await symmToken.balanceOf(context.signers.symmioFoundation.address)
			expect(foundationBalance).to.equal(e(500)) // Check foundation balance
		})

		it("should revert if admin tries to claim more than available", async () => {
			await expect(symmClaim.connect(context.signers.admin).adminClaim(e(1000))).to.be.revertedWithCustomError(
				symmClaim,
				"AdminClaimAmountExceedsAvailable",
			)
		})
	})
}
