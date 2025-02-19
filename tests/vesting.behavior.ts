import { initializeFixture, RunContext } from "./Initialize.fixture";
import { Vesting } from "../typechain-types";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

export function ShouldBehaveLikeVesting(){
	let context: RunContext;
	let vesting: Vesting;

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		vesting = context.vesting
	})

	describe("Deployment", () => {
		it("should grant the admin role to the deployer", async () => {
			const hasRole = await vesting.hasRole(await vesting.DEFAULT_ADMIN_ROLE(), context.signers.admin.address)
			expect(hasRole).to.be.true
		})
	})
}