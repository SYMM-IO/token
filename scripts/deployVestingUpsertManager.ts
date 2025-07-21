const { ethers, upgrades } = require("hardhat")

async function main() {
	const [deployer] = await ethers.getSigners()

	console.log("Deploying with account:", deployer.address)

	const admin = ""
	const operator = ""
	const vestingAddress = "0x5733105364c8136226e246455328884c23151C60"
	const vestingPlanAddress = "0xbf4B1201e3F2E862B48D763f4c6EAA5Ef0738B15"

	const Factory = await ethers.getContractFactory("VestingUpsertManager")
	const contract = await upgrades.deployProxy(Factory, [admin, operator, vestingAddress, vestingPlanAddress], { initializer: "initialize" })
	await contract.waitForDeployment()

	const addresses = {
		proxy: await contract.getAddress(),
		admin: await upgrades.erc1967.getAdminAddress(await contract.getAddress()),
		implementation: await upgrades.erc1967.getImplementationAddress(await contract.getAddress()),
	}
	console.log("VestingUpsertManager deployed to", addresses)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
