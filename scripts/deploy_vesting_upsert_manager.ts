const { ethers, upgrades } = require("hardhat");

async function main() {
	const [deployer] = await ethers.getSigners();

	console.log("Deploying with account:", deployer.address);

	const admin = deployer.address;
	const vestingAddress = "0x5733105364c8136226e246455328884c23151C60";
	const vestingPlanAddress = "0xbf4B1201e3F2E862B48D763f4c6EAA5Ef0738B15";

	const VestingUpsertManager = await ethers.getContractFactory("VestingUpsertManager");

	const proxy = await upgrades.deployProxy(
		VestingUpsertManager,
		[admin, vestingAddress, vestingPlanAddress],
		{
			initializer: "initialize",
		},
	);

	await proxy.deployed();

	console.log("VestingUpsertManager proxy deployed to:", proxy.address);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
