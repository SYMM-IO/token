import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers, network } from "hardhat"
import { SymmVesting, VestingPlanOps__factory } from "../typechain-types"
import { initializeFixture, RunContext } from "./Initialize.fixture"

export function ShouldBehaveLikeVesting() {
	let context: RunContext
	let symmVesting: SymmVesting
	let vestingPlanOps: VestingPlanOps__factory

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		symmVesting = await context.vesting
		vestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
	})

	describe("__vesting_init", () => {
		it("Should grant the admin role to the deployer", async () => {
			for (const role of [
				await symmVesting.DEFAULT_ADMIN_ROLE(),
				await symmVesting.SETTER_ROLE(),
				await symmVesting.PAUSER_ROLE(),
				await symmVesting.UNPAUSER_ROLE(),
				await symmVesting.OPERATOR_ROLE(),
			]) {
				const hasRole = await symmVesting.hasRole(role, context.signers.admin.address)
				expect(hasRole).to.be.true
			}
		})
	})

	describe("setupVestingPlans", () => {
		it("Should fail if users and amount arrays mismatch", async () => {
			const users = [await context.signers.user1.getAddress(), await context.signers.user2.getAddress()]
			const amounts = ["1000"]

			await expect(symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.revertedWithCustomError(
				symmVesting,
				"MismatchArrays",
			)
		})

		it("Should fail if vestingPlan setup before", async () => {
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)
			await expect(symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.revertedWithCustomError(
				vestingPlanOps,
				"AlreadySetup",
			)
		})

		it("Should setup vestingPlan successfully", async () => {
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const oldTotalVesting = await symmVesting.totalVested(await context.symmioToken.getAddress())

			expect(await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.not.reverted

			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const newTotalVesting = await symmVesting.totalVested(await context.symmioToken.getAddress())

			expect(newTotalVesting).to.be.equal(oldTotalVesting + "1000")

			expect(plan.startTime).to.be.equal("0")
			expect(plan.endTime).to.be.equal("0")
			expect(plan.amount).to.be.equal(amounts[0])
			expect(plan.claimedAmount).to.be.equal(0)
		})
	})

	describe("claimUnlockedToken", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting.getAddress(), 5000)
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should unlockedAmount be zero before vesting starts", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const latestBlock = await ethers.provider.getBlock("latest")
			const safeTimestamp = Number(plan.startTime) - 100

			if (safeTimestamp <= (latestBlock?.timestamp ?? 0)) {
				await network.provider.send("evm_setNextBlockTimestamp", [(latestBlock?.timestamp ?? 0) + 1])
			} else {
				await network.provider.send("evm_setNextBlockTimestamp", [safeTimestamp])
			}

			await network.provider.send("evm_mine")

			expect(await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(0)
		})

		it("Should unlockedAmount be zero at the exact start time", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const latestBlock = await ethers.provider.getBlock("latest")
			const safeTimestamp = Number(plan.startTime)

			if (safeTimestamp <= (latestBlock?.timestamp ?? 0)) {
				await network.provider.send("evm_setNextBlockTimestamp", [(latestBlock?.timestamp ?? 0) + 1])
			} else {
				await network.provider.send("evm_setNextBlockTimestamp", [safeTimestamp])
			}

			await network.provider.send("evm_mine")

			expect(await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(0)
		})

		it("Should unlockedAmount be partial during the vesting period", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const midTime = Math.floor(Number((plan.startTime + plan.endTime) / BigInt(2)))

			await network.provider.send("evm_setNextBlockTimestamp", [midTime]) // half of vesting lock
			await network.provider.send("evm_mine")

			const expectedUnlocked = Math.floor(Number((BigInt(1000) * (BigInt(midTime) - plan.startTime)) / (plan.endTime - plan.startTime)))

			expect(await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(expectedUnlocked)
		})

		it("Should unlockedAmount be the full amount at the exact end time", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			await network.provider.send("evm_setNextBlockTimestamp", [Number(plan.endTime)])
			await network.provider.send("evm_mine")

			expect(await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(1000)
		})

		it("Should claimUnlockedToken successfully", async () => {
			let plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			await network.provider.send("evm_setNextBlockTimestamp", [Number(plan.endTime)])
			await network.provider.send("evm_mine")

			const oldTotalVested = await symmVesting.totalVested(context.symmioToken)
			const oldClaimedAmount = plan.claimedAmount
			const oldContractBalance = await context.symmioToken.balanceOf(symmVesting)
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			expect(await symmVesting.connect(context.signers.user1).claimUnlockedToken(await context.symmioToken.getAddress())).to.be.not.reverted
			plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const newTotalVested = await symmVesting.totalVested(context.symmioToken)
			const newClaimedAmount = plan.claimedAmount
			const newContractBalance = await context.symmioToken.balanceOf(symmVesting)
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			expect(newTotalVested).to.be.equal(oldTotalVested - BigInt(1000))
			expect(newClaimedAmount).to.be.equal(oldClaimedAmount + BigInt(1000))
			expect(newContractBalance).to.be.equal(oldContractBalance - BigInt(1000))
			expect(newUserBalance).to.be.equal(oldUserBalance + BigInt(1000))
		})
	})

	describe("claimLockedToken", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting.getAddress(), 5000)
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should fail if amount be greater than lockedAmount", async () => {
			await expect(symmVesting.claimLockedToken(context.symmioToken, 1001)).to.be.revertedWithCustomError(symmVesting, "InvalidAmount")
		})

		it("Should not revert when claiming locked tokens within allowed amount", async () => {
			await expect(symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)).to.be.not.reverted
		})

		it("Should decrease total vested amount after claiming", async () => {
			const oldTotalVested = await symmVesting.totalVested(context.symmioToken)

			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const newTotalVested = await symmVesting.totalVested(context.symmioToken)
			expect(newTotalVested).to.be.equal(oldTotalVested - BigInt(1000))
		})

		it("Should distribute claimed amount correctly", async () => {
			const oldPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const newPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			expect(newPenaltyContractBalance).to.be.equal(oldPenaltyContractBalance + BigInt(500))
			expect(newUserBalance).to.be.equal(oldUserBalance + BigInt(500))
		})

		it("Should reset claimed amount to zero after claiming", async () => {
			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			expect(plan.claimedAmount).to.be.equal(0)
		})

		it("Should update vesting startTime and endTime after claiming", async () => {
			const oldPlan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const tx = await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const receipt = await tx.wait()
			const blockAfter = await ethers.provider.getBlock(receipt?.blockNumber ?? 0)
			const actualNewStartTime = blockAfter?.timestamp ?? 0
			const remainingDuration = Number(oldPlan.endTime) - Number(actualNewStartTime)

			const planAfter = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const expectedNewEndTime = actualNewStartTime + remainingDuration

			expect(planAfter.startTime).to.equal(actualNewStartTime)
			expect(planAfter.endTime).to.equal(expectedNewEndTime)
		})
	})

	describe("resetVestingPlans", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting, 5000)

			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should reset vesting plan successfully", async () => {
			const user = await context.signers.user1.getAddress()
			const newAmount = BigInt(1500)
			const token = await context.symmioToken.getAddress()

			const planBefore = await symmVesting.vestingPlans(token, user)
			const totalVestedBefore = await symmVesting.totalVested(token)

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [newAmount]))
				.to.emit(symmVesting, "VestingPlanReset")
				.withArgs(token, user, newAmount)

			const planAfter = await symmVesting.vestingPlans(token, user)
			const totalVestedAfter = await symmVesting.totalVested(token)

			expect(planAfter.amount).to.equal(newAmount)
			expect(planAfter.claimedAmount).to.equal(0)
			expect(totalVestedAfter).to.equal(totalVestedBefore - planBefore.amount + newAmount)
		})

		it("Should fail if users and amounts arrays have different lengths", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [])).to.be.revertedWithCustomError(
				symmVesting,
				"MismatchArrays",
			)
		})

		it("Should fail if new amount is less than already claimed amount", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()

			const plan = await symmVesting.vestingPlans(token, user)
			console.log("Claimed After Reset:", plan.claimedAmount.toString())

			const midTime = Math.floor(Number((plan.startTime + plan.endTime) / BigInt(2)))

			await network.provider.send("evm_setNextBlockTimestamp", [midTime]) // half of vesting lock
			await network.provider.send("evm_mine")

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [400])).to.be.revertedWithCustomError(
				symmVesting,
				"AlreadyClaimedMoreThanThis",
			)
		})

		it("Should claim unlocked tokens before resetting", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()
			const newAmount = 1200

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [newAmount])).to.not.be.reverted

			const planAfter = await symmVesting.vestingPlans(token, user)
			expect(planAfter.claimedAmount).to.equal(0)
		})
	})
}
