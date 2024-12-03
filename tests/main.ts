import { shouldBehaveLikeSymmAllocationClaimer } from "./symmAllocationClaimer.bhavior"
import { shouldBehaveLikeSymmioToken } from "./symmioToken.behavior"

describe("Symmio Token", () => {
	describe("Static Tests", async function () {
		describe("Symm token", async function () {
			shouldBehaveLikeSymmioToken()
		})
		describe("Allocation Claimer", async function () {
			shouldBehaveLikeSymmAllocationClaimer()
		})
	})
})
