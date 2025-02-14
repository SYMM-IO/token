import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

task("deploy:Vesting", "Deploys the Vesting contract")
	.addParam("owner", "The owner of the Vesting contract")
	.addParam("totalTime", "The total vesting duration in seconds")
	.addParam("startTime", "The start time of the vesting period in UNIX timestamp")
	.addParam("symmAddress", "The address of the Symmio token contract")
	.setAction(async ({owner, totalTime, startTime, symmAddress }, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		console.log("deploy:Vesting");

		const VestingFactory = await ethers.getContractFactory("Vesting");
		const vestingContract = await upgrades.deployProxy(VestingFactory, [owner, totalTime, startTime, symmAddress], { initializer: "initialize" });
		await vestingContract.waitForDeployment();

		console.log(`Vesting Contract deployed at: ${await vestingContract.getAddress()}`);
		return vestingContract;
	});
