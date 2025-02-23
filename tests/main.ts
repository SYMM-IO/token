import { shouldBehaveLikeAirdropHelper } from "./AirdropHelper.behavior"
import { shouldBehaveLikeSymmAllocationClaimer } from "./symmAllocationClaimer.bhavior"
import { shouldBehaveLikeSymmioToken } from "./symmioToken.behavior"
import { ShouldBehaveLikeVesting } from "./vesting.behavior"

describe("Symmio Token", () => {
	if (process.env.TEST_MODE === "static") {
		// Static tests
		describe("Static Tests", async function () {
			describe("Symm token", async function () {
				shouldBehaveLikeSymmioToken()
			})

			describe("Allocation Claimer", async function () {
				shouldBehaveLikeSymmAllocationClaimer()
			})

			describe("ٰVesting", async function () {
				ShouldBehaveLikeVesting()
			})
		})
	} else if (process.env.TEST_MODE === "dynamic") {
		// Dynamic tests
		describe("Dynamic Tests", async function () {
			describe("Airdrop Helper", async function () {
				shouldBehaveLikeAirdropHelper()
			})
		})
	}
})
