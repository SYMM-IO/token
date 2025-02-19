import { shouldBehaveLikeAirdropHelper } from "./AirdropHelper.behavior"
import { shouldBehaveLikeSymmAllocationClaimer } from "./symmAllocationClaimer.bhavior"
import { shouldBehaveLikeSymmioToken } from "./symmioToken.behavior"
import { ShouldBehaveLikeVesting } from "./vesting.behavior"

describe("Symmio Token", () => {
	describe("Static Tests", async function () {
		describe("Symm token", async function () {
			shouldBehaveLikeSymmioToken()
		})

		describe("Allocation Claimer", async function () {
			shouldBehaveLikeSymmAllocationClaimer()
		})

		describe("AirdropHelper", async function () {
			shouldBehaveLikeAirdropHelper()
		})

		describe("ٰVesting", async function () {
			ShouldBehaveLikeVesting()
		})
	})
})