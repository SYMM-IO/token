import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"

task("deploy:SymmioBuildersNft", "Deploys the SymmioBuildersNft contract")
	.addParam("admin", "Address receiving the NFT admin and pause roles")
	.setAction(async ({ admin }, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		if (!ethers.isAddress(admin) || admin === ethers.ZeroAddress) throw new Error("Invalid NFT admin address")

		console.log("deploy:SymmioBuildersNft")
		console.log(`Admin: ${admin}`)

		const factory = await ethers.getContractFactory("SymmioBuildersNft")
		const contract = await upgrades.deployProxy(factory, [admin], { initializer: "initialize" })
		await contract.waitForDeployment()

		const proxyAddress = await contract.getAddress()
		const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
		console.log(`SymmioBuildersNft proxy: ${proxyAddress}`)
		console.log(`SymmioBuildersNft implementation: ${implementationAddress}`)
		return contract
	})
