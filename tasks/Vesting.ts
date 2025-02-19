import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"

task("deploy:Vesting", "Deploys the Vesting contract")
	.addParam("admin", "The admin of the Vesting contract")
	.addParam("lockedClaimPenalty", "Penalty rate (scaled by 1e18) for locked token claims")
	.addParam("lockedClaimPenaltyReceiver", "Address that receives the penalty")
	.setAction(async ({ admin, lockedClaimPenalty, lockedClaimPenaltyReceiver }, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:Vesting")

		const VestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
		const vestingPlanOps = await upgrades.deployProxy(VestingPlanOps)
		await vestingPlanOps.waitForDeployment()

		const VestingFactory = await ethers.getContractFactory("Vesting", {
			libraries: {
				VestingPlanOps: await vestingPlanOps.getAddress(),
			},
		})
		const vestingContract = await upgrades.deployProxy(VestingFactory, [admin, lockedClaimPenalty, lockedClaimPenaltyReceiver], {
			initializer: "__vesting_init",
			unsafeAllow: ["external-library-linking"],
		})
		await vestingContract.waitForDeployment()

		console.log(`Vesting Contract deployed at: ${await vestingContract.getAddress()}`)
		return vestingContract
	})
