/* eslint-disable node/no-missing-import */
import { expect } from "chai"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import { SymmVestingPlanInitializer, Vesting } from "../typechain-types"
import { initializeFixture, RunContext } from "./Initialize.fixture"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { ethers } from "hardhat"
import { NumberLike } from "@nomicfoundation/hardhat-network-helpers/dist/src/types"
import { BigNumberish } from "ethers"
import { e } from "../utils"

export function shouldBehaveLikeSymmVestingPlanInitializer() {
	let context: RunContext
	let vestingPlanInitializer: SymmVestingPlanInitializer // keep the same naming pattern the user showed
	let admin: SignerWithAddress
	let user1: SignerWithAddress
	let user2: SignerWithAddress
	let launchTime: NumberLike

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		vestingPlanInitializer = context.symmVestingVlanInitializer
		;({ admin, user1, user2 } = context.signers)
		launchTime = await vestingPlanInitializer.launchDay()
	})

	/* ---------------------------------------------------------------------- */
	/*                    setPendingAmounts() tests                  */
	/* ---------------------------------------------------------------------- */
	describe("setPendingAmounts", () => {
		it("should revert on mismatched array lengths", async () => {
			await expect(vestingPlanInitializer.connect(admin).setPendingAmounts([user1.address], [100, 200])).to.be.revertedWithCustomError(
				vestingPlanInitializer,
				"MismatchedArrays",
			)
		})

		it("should reject callers without SETTER_ROLE", async () => {
			await expect(vestingPlanInitializer.connect(user1).setPendingAmounts([user1.address], [1000])).to.be.reverted
		})

		it("should register user allocations correctly", async () => {
			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1.address, user2.address], [1000, 2000])

			expect(await vestingPlanInitializer.pendingAmount(user1.address)).to.equal(1000)
			expect(await vestingPlanInitializer.pendingAmount(user2.address)).to.equal(2000)
			expect(await vestingPlanInitializer.pendingTotal()).to.equal(3000)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1.address, user2.address], [150, 430])

			expect(await vestingPlanInitializer.pendingAmount(user1.address)).to.equal(150)
			expect(await vestingPlanInitializer.pendingAmount(user2.address)).to.equal(430)
			expect(await vestingPlanInitializer.pendingTotal()).to.equal(430 + 150)
		})

		it("should enforce the global SYMM cap", async () => {
			const overCap = ethers.parseEther("10000001")
			await expect(vestingPlanInitializer.connect(admin).setPendingAmounts([user1.address], [overCap])).to.be.revertedWithCustomError(
				vestingPlanInitializer,
				"exceededMaxSymmAmount",
			)
		})
	})

	/* ---------------------------------------------------------------------- */
	/*                       startVesting() tests                       */
	/* ---------------------------------------------------------------------- */
	describe("startVesting", () => {
		beforeEach(async () => {
			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [1000])
		})

		it("should revert if the caller has no initiatable amount", async () => {
			await expect(vestingPlanInitializer.connect(user2).startVesting()).to.be.revertedWithCustomError(vestingPlanInitializer, "ZeroAmount")
		})

		it("should revert while the contract is paused", async () => {
			await vestingPlanInitializer.connect(admin).pause()
			await expect(vestingPlanInitializer.connect(user1).startVesting()).to.be.revertedWithCustomError(vestingPlanInitializer, "EnforcedPause")
		})

		it("should revert if launch time is not reached", async () => {
			await expect(vestingPlanInitializer.connect(user1).startVesting()).to.be.reverted
		})

		it("should allow user to initiate it's vesting plan when admin has allowed him", async () => {
			await time.increaseTo(launchTime)

			await expect(vestingPlanInitializer.connect(user1).startVesting()).to.not.be.reverted

			expect(await vestingPlanInitializer.pendingAmount(user1.address)).to.equal(0)
			expect(await vestingPlanInitializer.vestedAmount(user1.address)).to.equal(1000)
		})
	})

	/* ---------------------------------------------------------------------- */
	/*                                Pausing                                  */
	/* ---------------------------------------------------------------------- */
	describe("pause/unpause", () => {
		it("should allow pausing and prevent vesting requests while paused", async () => {
			await time.increaseTo(launchTime)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [1000])
			await vestingPlanInitializer.connect(admin).pause()

			await expect(vestingPlanInitializer.connect(user1).startVesting()).to.be.revertedWithCustomError(vestingPlanInitializer, "EnforcedPause")

			await vestingPlanInitializer.connect(admin).unpause()

			await expect(vestingPlanInitializer.connect(user1).startVesting()).to.not.be.reverted
		})

		it("should not allow non-registered addresses to pause/unpause", async () => {
			await expect(vestingPlanInitializer.connect(user1).pause()).to.be.revertedWithCustomError(
				vestingPlanInitializer,
				"AccessControlUnauthorizedAccount",
			)
			await expect(vestingPlanInitializer.connect(user1).unpause()).to.be.revertedWithCustomError(
				vestingPlanInitializer,
				"AccessControlUnauthorizedAccount",
			)
		})
	})

	/* ---------------------------------------------------------------------- */
	/*                              endTime()                               */
	/* ---------------------------------------------------------------------- */
	describe("endTime()", () => {
		it("should extend linearly with penalty as days pass", async () => {
			await time.increaseTo(launchTime)
			const before = await vestingPlanInitializer.endTime()
			expect(before).to.equal(Number(launchTime) + 180 * 24 * 60 * 60)
			const tenDays = 10 * 24 * 60 * 60
			await time.increaseTo(Number(launchTime) + tenDays)
			const after = await vestingPlanInitializer.endTime()
			expect((Number(after) - Number(before)) / 60 / 60 / 24).to.equal(2.5) //after - before = (launch + 10 + 172.5) - (launch + 180) = 2.5
		})

		it("should give maximum decay after 180 days", async () => {
			const oneDay = 24 * 60 * 60
			const oneHundredEightyDays = 180 * oneDay
			const tenDays = 10 * oneDay
			await time.increaseTo(Number(launchTime) + oneHundredEightyDays + tenDays)
			const endTime = await vestingPlanInitializer.endTime()
			expect(endTime).to.equal(Number(launchTime) + oneHundredEightyDays + tenDays + 45 * oneDay)
		})
	})

	/* ---------------------------------------------------------------------- */
	/*                              View variables                            */
	/* ---------------------------------------------------------------------- */
	describe("viewVariables", () => {
		beforeEach(async () => {
			await time.increaseTo(launchTime)
		})

		it("should calculate pendingTotal and vestedAmount correctly while admin decreases initiatable amount", async () => {
			const beforeInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(beforeInitiatableAmountSum).to.equal(0)

			const vestedAmount = await vestingPlanInitializer.vestedAmount(user1)
			expect(vestedAmount).to.equal(0)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [1000])

			const firstInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(firstInitiatableAmountSum).to.equal(1000)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [250])

			const secondInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(secondInitiatableAmountSum).to.equal(250)

			await vestingPlanInitializer.connect(user1).startVesting()

			expect(await vestingPlanInitializer.pendingAmount(user1)).to.equal(0)
			expect(await vestingPlanInitializer.vestedAmount(user1)).to.equal(250)
		})

		it("should calculate pendingTotal and vestedAmount correctly while admin increases initiatable amount", async () => {
			const beforeInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(beforeInitiatableAmountSum).to.equal(0)

			const vestedAmount = await vestingPlanInitializer.vestedAmount(user1)
			expect(vestedAmount).to.equal(0)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [1000])

			const firstInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(firstInitiatableAmountSum).to.equal(1000)

			await vestingPlanInitializer.connect(admin).setPendingAmounts([user1], [2500])

			const secondInitiatableAmountSum = await vestingPlanInitializer.pendingTotal()
			expect(secondInitiatableAmountSum).to.equal(2500)

			await vestingPlanInitializer.connect(user1).startVesting()

			expect(await vestingPlanInitializer.pendingAmount(user1)).to.equal(0)
			expect(await vestingPlanInitializer.vestedAmount(user1)).to.equal(2500)
			expect(secondInitiatableAmountSum).to.equal(2500)
		})

		it("should have 0.25e18 as penalty per day and 180 days for total days", async () => {
			const penaltyPerDay = await vestingPlanInitializer.PENALTY_PER_DAY_BP()
			expect(penaltyPerDay).to.equal(e("0.25"))

			const totalDays = await vestingPlanInitializer.VESTING_DURATION()
			expect(totalDays).to.equal(60 * 24 * 60 * 60) // 60 days
		})
	})
}
