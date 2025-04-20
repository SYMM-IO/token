import {task} from "hardhat/config";
import {HardhatRuntimeEnvironment} from "hardhat/types";

task("deploy:SymmVestingPlanInitializer", "Deploys the SymmVestingPlanInitializer contract")
	.addParam("admin", "The admin of SymmVestingPlanInitializer")
	.addParam("symmTokenAddress", "Address of the symm token")
	.addParam("symmVestingAddress", "Address of the symmVestingContract")
	.addParam("totalInitiatableSYMM", "Total initiatable symm")
	.addParam("launchTimeStamp", "The of the launch in seconds")
	.setAction(async ({admin, symmTokenAddress, symmVestingAddress, totalInitiatableSYMM, launchTimeStamp}, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:SymmVestingPlanInitializer");

		const SymmVestingPlanInitializer = await ethers.getContractFactory("SymmVestingPlanInitializer");
		console.log(admin, symmTokenAddress, symmVestingAddress, totalInitiatableSYMM, launchTimeStamp)
		const symmVestingPlanInitializer = await SymmVestingPlanInitializer.deploy(admin, symmTokenAddress, symmVestingAddress, totalInitiatableSYMM, launchTimeStamp)
		await symmVestingPlanInitializer.waitForDeployment();

		console.log(`symmVestingPlanInitializer Contract deployed at: ${await symmVestingPlanInitializer.getAddress()}`)
		return symmVestingPlanInitializer
	}
)