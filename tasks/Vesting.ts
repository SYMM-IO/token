import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"

task("deploy:Vesting", "Deploys the Vesting contract")
	.addParam("admin", "The admin of the Vesting contract")
	.addParam("lockedClaimPenaltyReceiver", "Address that receives the penalty")
	.setAction(async ({ admin, lockedClaimPenaltyReceiver }, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:Vesting")

		const VestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
		const vestingPlanOps = await upgrades.deployProxy(VestingPlanOps)
		await vestingPlanOps.waitForDeployment()

		const VestingFactory = await ethers.getContractFactory("SymmVesting", {
			libraries: {
				VestingPlanOps: await vestingPlanOps.getAddress(),
			},
		})
		const vestingContract = await upgrades.deployProxy(VestingFactory, [admin, lockedClaimPenaltyReceiver], {
			unsafeAllow: ["external-library-linking"],
			initializer: "initialize"
		})
		console.log("Before Wait")
		await vestingContract.waitForDeployment()

		console.log(`SymmVesting Contract deployed at: ${await vestingContract.getAddress()}`)
		return vestingContract
	})
