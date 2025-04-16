import {task} from "hardhat/config";
import {HardhatRuntimeEnvironment} from "hardhat/types";

task("deploy:SymmVestingPlanInitializer", "Deploys the SymmVestingPlanInitializer contract")
	.addParam("admin", "The admin of SymmVestingPlanInitializer")
	.addParam("symmTokenAddress", "Address of the symm token")
	.addParam("symmVestingAddress", "Address of the symmVestingContract")
	.addParam("launchTimeStamp", "The of the launch in seconds")
	.setAction(async ({admin, symmAddress, symmVestingAddress, launchTimeStamp}, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:SymmVestingPlanInitializer");

		const SymmVestingPlanInitializer = await ethers.getContractFactory("SymmVestingPlanInitializer");
		const symmVestingPlanInitializer = await upgrades.deployProxy(SymmVestingPlanInitializer, [admin, symmAddress, symmVestingAddress, launchTimeStamp], {
			unsafeAllow: ["external-library-linking"],
			initializer: "initialize",
		})
		await symmVestingPlanInitializer.waitForDeployment();

		console.log(`symmVestingPlanInitializer Contract deployed at: ${await symmVestingPlanInitializer.getAddress()}`)
		return symmVestingPlanInitializer
	}
)