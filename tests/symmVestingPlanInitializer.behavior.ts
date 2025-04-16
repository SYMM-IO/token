import { expect } from "chai"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { SymmVestingRequester, Vesting } from "../typechain-types"
import { initializeFixture, RunContext } from "./Initialize.fixture"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { ethers } from "hardhat"

export function shouldBehaveLikeSymmVestingRequester() {
	let context: RunContext
	let vestingRequester: SymmVestingRequester
	let vesting: Vesting
	let admin: SignerWithAddress
	let setter: SignerWithAddress
	let user1: SignerWithAddress
	let user2: SignerWithAddress

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		vestingRequester = context.symmVestingVlanInitializer
		vesting = context.vesting
		admin = context.signers.admin
		setter = context.signers.setter
		user1 = context.signers.user1
		user2 = context.signers.user2
	})

	describe("registerPlans", () => {
		it("should revert on mismatched array lengths", async () => {
			await expect(
				vestingRequester.connect(setter).registerPlans([user1.address], [100, 200])
			).to.be.revertedWithCustomError(vestingRequester, "MismatchedArrays")
		})

		it("should register user allocations correctly", async () => {
			await vestingRequester.connect(setter).registerPlans(
				[user1.address, user2.address],
				[1000, 2000]
			)

			expect(await vestingRequester.registeredAmounts(user1.address)).to.equal(1000)
			expect(await vestingRequester.registeredAmounts(user2.address)).to.equal(2000)
		})
	})

	describe("requestVestingPlan", () => {
		it("should revert if user not registered", async () => {
			await expect(
				vestingRequester.connect(user1).requestVestingPlan()
			).to.be.revertedWithCustomError(vestingRequester, "ZeroAmount")
		})

		it("should call setupVestingPlans and clear amount", async () => {
			await vestingRequester.connect(setter).registerPlans([user1.address], [1000])

			const tx = await vestingRequester.connect(user1).requestVestingPlan()
			await tx.wait()

			expect(await vestingRequester.registeredAmounts(user1.address)).to.equal(0)
			// Additional validation depends on mocking or reading from vesting contract if testable
		})
	})

	describe("pause/unpause", () => {
		it("should allow pausing and prevent vesting requests while paused", async () => {
			await vestingRequester.connect(setter).registerPlans([user1.address], [1000])
			await vestingRequester.connect(admin).pause()

			await expect(
				vestingRequester.connect(user1).requestVestingPlan()
			).to.be.revertedWith("Pausable: paused")

			await vestingRequester.connect(admin).unpause()

			await expect(
				vestingRequester.connect(user1).requestVestingPlan()
			).to.not.be.reverted
		})
	})
}
