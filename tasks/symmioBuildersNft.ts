import { upgrades } from "@openzeppelin/hardhat-upgrades"
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"

type DeploySymmioBuildersNftArguments = {
	admin: string
}

export default async function deploySymmioBuildersNft(
	{ admin }: DeploySymmioBuildersNftArguments,
	hre: HardhatRuntimeEnvironment,
) {
	const connection = await hre.network.create()
	const { ethers } = connection
	const upgradesApi = await upgrades(hre, connection)
	if (!ethers.isAddress(admin) || admin === ethers.ZeroAddress) throw new Error("Invalid required --admin address")

	console.log("deploy:SymmioBuildersNft")
	console.log(`Admin: ${admin}`)

	const factory = await ethers.getContractFactory("SymmioBuildersNft")
	const contract = await upgradesApi.deployProxy(factory, [admin], { initializer: "initialize" })
	await contract.waitForDeployment()

	const proxyAddress = await contract.getAddress()
	const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(proxyAddress)
	console.log(`SymmioBuildersNft proxy: ${proxyAddress}`)
	console.log(`SymmioBuildersNft implementation: ${implementationAddress}`)
	return contract
}
