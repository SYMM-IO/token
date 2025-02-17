import { initializeFixture, RunContext } from "./Initialize.fixture";
import { Vesting } from "../typechain-types";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

export function ShouldBehaveLikeVestingBehavior(){
	let context: RunContext;
	let vesting: Vesting;

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		vesting = await context.vesting
	})

	describe("Deployment", ()=>{
		it()
	})
}