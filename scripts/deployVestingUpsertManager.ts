import { upgrades } from "@openzeppelin/hardhat-upgrades"
import hre from "hardhat"

async function main() {
	const connection = await hre.network.create()
	const { ethers } = connection
	const upgradesApi = await upgrades(hre, connection)
	const [deployer] = await ethers.getSigners()

	console.log("Deploying with account:", deployer.address)

	const admin = ""
	const operator = ""
	const vestingAddress = "0x5733105364c8136226e246455328884c23151C60"
	const vestingPlanAddress = "0xbf4B1201e3F2E862B48D763f4c6EAA5Ef0738B15"

	const factory = await ethers.getContractFactory("VestingUpsertManager")
	const contract = await upgradesApi.deployProxy(factory, [admin, operator, vestingAddress, vestingPlanAddress], {
		initializer: "initialize",
	})
	await contract.waitForDeployment()

	const proxy = await contract.getAddress()
	const addresses = {
		proxy,
		admin: await upgradesApi.erc1967.getAdminAddress(proxy),
		implementation: await upgradesApi.erc1967.getImplementationAddress(proxy),
	}
	console.log("VestingUpsertManager deployed to", addresses)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
