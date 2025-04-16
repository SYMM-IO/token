import {task} from "hardhat/config";
import {HardhatRuntimeEnvironment} from "hardhat/types";

task("deploy:SymmVestingRequester", "Deploys the SymmVestingRequester contract")
	.addParam("admin", "The admin of SymmVestingRequester")
	.addParam("symm_token_address", "Address of the symm token")
	.addParam("symm_vesting_address", "Address of the symmVestingContract")
	.setAction(async ({admin, symmAddress, symmVestingAddress}, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:SymmVestingRequester");

		const SymmVestingRequester = await ethers.getContractFactory("SymmVestingRequester");
		const symmVestingRequester = await upgrades.deployProxy(SymmVestingRequester, [admin, symmAddress, symmVestingAddress], {
			unsafeAllow: ["external-library-linking"],
			initializer: "initialize",
		})
		await symmVestingRequester.waitForDeployment();

		console.log(`SymmVestingRequester Contract deployed at: ${await symmVestingRequester.getAddress()}`)
		return symmVestingRequester
	}
)