import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"

type DeploySymmioTokenArguments = {
	name: string
	symbol: string
	admin: string
}

export default async function deploySymmioToken(
	{ name, symbol, admin }: DeploySymmioTokenArguments,
	hre: HardhatRuntimeEnvironment,
) {
	const { ethers } = await hre.network.getOrCreate()
	if (name.length === 0) throw new Error("Missing required --name option")
	if (symbol.length === 0) throw new Error("Missing required --symbol option")
	if (!ethers.isAddress(admin) || admin === ethers.ZeroAddress) throw new Error("Invalid required --admin address")

	console.log("deploy:SymmioToken")
	const [owner] = await ethers.getSigners()
	const factory = await ethers.getContractFactory("Symmio")
	const token = await factory.connect(owner).deploy(name, symbol, admin)
	await token.waitForDeployment()

	console.log(`Symmio Token deployed: ${await token.getAddress()}`)
	return token
}
