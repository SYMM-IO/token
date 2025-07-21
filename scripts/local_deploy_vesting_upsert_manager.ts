// scripts/deploy.ts
import { ethers, network } from "hardhat";

async function main() {
	const [deployer] = await ethers.getSigners();

	console.log("Deploying contracts with:", deployer.address);

	const admin = deployer.address;
	const vestingAddress = "0x5733105364c8136226e246455328884c23151C60";
	const initializerAddress = "0xbf4B1201e3F2E862B48D763f4c6EAA5Ef0738B15";
	const defaultAdmin = "0x8CF65060CdA270a3886452A1A1cb656BECEE5bA4";
	const account1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

	const vestingContract = await ethers.getContractAt("Vesting", vestingAddress);
	const vestingPlanContract = await ethers.getContractAt("SymmVestingPlanInitializer", initializerAddress);

	const VestingUpsertManager = await ethers.getContractFactory("VestingUpsertManager");
	const upsertManager = await VestingUpsertManager.deploy(admin, vestingAddress, initializerAddress);

	await upsertManager.waitForDeployment();

	console.log("VestingUpsertManager deployed to:", await upsertManager.getAddress());

	await network.provider.request({
		method: "hardhat_impersonateAccount",
		params: [defaultAdmin],
	});

	await deployer.sendTransaction({
		to: defaultAdmin,
		value: ethers.parseEther("1")
	})

	const signer = await ethers.getSigner(defaultAdmin);
	const OPERATOR_ROLE = await upsertManager.OPERATOR_ROLE();
	const SETTER_ROLE = await vestingContract.SETTER_ROLE();

	await vestingContract.connect(signer).grantRole(OPERATOR_ROLE, account1);
	await vestingContract.connect(signer).grantRole(SETTER_ROLE, await upsertManager.getAddress());
	await vestingPlanContract.connect(signer).grantRole(OPERATOR_ROLE, account1);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
