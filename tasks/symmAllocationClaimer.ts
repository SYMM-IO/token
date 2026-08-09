import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"

type DeploySymmAllocationClaimerArguments = {
	admin: string
	setter: string
	token: string
	symmioFoundation: string
	mintFactor: string
}

export default async function deploySymmAllocationClaimer(
	{ admin, setter, token, symmioFoundation, mintFactor }: DeploySymmAllocationClaimerArguments,
	hre: HardhatRuntimeEnvironment,
) {
	const { ethers } = await hre.network.getOrCreate()
	for (const [name, address] of Object.entries({ admin, setter, token, symmioFoundation })) {
		if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`Invalid required --${name} address`)
	}
	if (mintFactor.length === 0) throw new Error("Missing required --mint-factor option")

	console.log("deploy:SymmAllocationClaimer")
	const [owner] = await ethers.getSigners()
	const factory = await ethers.getContractFactory("SymmAllocationClaimer")
	const claimer = await factory.connect(owner).deploy(admin, setter, token, symmioFoundation, mintFactor)
	await claimer.waitForDeployment()

	console.log(`SymmAllocationClaimer deployed: ${await claimer.getAddress()}`)
	return claimer
}
