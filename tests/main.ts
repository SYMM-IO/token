import { shouldBehaveLikeSymmAllocationClaimer } from "./symmAllocationClaimer.behavior"
import { shouldBehaveLikeSymmioToken } from "./symmioToken.behavior"
import { shouldBehaveLikeSymmStaking } from "./symmStaking.behavior"
import { shouldBehaveLikeSymmVesting } from "./symmVesting.behavior"
import { ShouldBehaveLikeVesting } from "./vesting.behavior"
import { shouldBehaveLikeSymmVestingPlanInitializer} from "./symmVestingPlanInitializer.behavior"
import { ShouldBehaveLikeVestingV2 } from "./vestingV2.behavior";

describe("Symmio Token", () => {
	// if (process.env.TEST_MODE === "static") {
		describe("Static Tests", async function () {
			// describe("Symm token", async function () {
			// 	shouldBehaveLikeSymmioToken()
			// })

			// describe("Allocation Claimer", async function () {
			// 	shouldBehaveLikeSymmAllocationClaimer()
			// })

			// describe("Airdrop Helper", async function () {
			// 	shouldBehaveLikeAirdropHelper() // Not adapted
			// })

			// describe("Symm Staking", async function () {
			// 	shouldBehaveLikeSymmStaking()
			// })

			// describe("Vesting", async function () {
			// 	ShouldBehaveLikeVesting()
			// })

			// describe("Symm Vesting Plan Initializer", async function () {
			// 	shouldBehaveLikeSymmVestingPlanInitializer()
			// })

			describe("Vesting V2", async function () {
				ShouldBehaveLikeVestingV2()
			})
		})
	// } else if (process.env.TEST_MODE === "dynamic") {
		// Dynamic tests
		// describe("Dynamic Tests", async function () {
		// 	describe("Symm Vesting", async function () {
		// 		shouldBehaveLikeSymmVesting()
		// 	})
		// })
	// }
})
