import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types"
import { upgrades, type HardhatUpgrades } from "@openzeppelin/hardhat-upgrades"
import type { Signer } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre"

export type SymmioBuildersNftManagerDeploymentArgs = {
	symm: string
	nft: string
	admin: string
	minlockamount: string
	cliffduration: string
	vestingduration: string
	penaltyrate: string
	penaltyreceiver: string
	grantroles?: boolean
	proxyadminowner?: string
}

export async function deploySymmioBuildersNftManager(
	args: SymmioBuildersNftManagerDeploymentArgs,
	ethers: HardhatEthers,
	upgradesApi: HardhatUpgrades,
	signer?: Signer,
) {
	const { symm, nft, admin, minlockamount, cliffduration, vestingduration, penaltyrate, penaltyreceiver } = args
	const grantroles = args.grantroles ?? false
	const addresses = { symm, nft, admin, penaltyreceiver, ...(args.proxyadminowner ? { proxyadminowner: args.proxyadminowner } : {}) }
	for (const [label, value] of Object.entries(addresses)) {
		if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`Invalid ${label} address`)
	}

	const minLockAmount = BigInt(minlockamount)
	const cliffDuration = BigInt(cliffduration)
	const vestingDuration = BigInt(vestingduration)
	const penaltyRate = BigInt(penaltyrate)
	if (minLockAmount <= 0n) throw new Error("minlockamount must be greater than zero")
	if (cliffDuration <= 0n) throw new Error("cliffduration must be greater than zero")
	if (vestingDuration <= 0n) throw new Error("vestingduration must be greater than zero")
	if (penaltyRate < 0n || penaltyRate > ethers.parseUnits("1", 18)) throw new Error("penaltyrate must be between 0 and 1e18")

	console.log("deploy:SymmioBuildersNftManager")
	console.table({
		symm,
		nft,
		admin,
		proxyadminowner: args.proxyadminowner ?? "signer default",
		minLockAmount,
		cliffDuration,
		vestingDuration,
		penaltyRate,
		penaltyreceiver,
		grantroles,
	})

	const factory = await ethers.getContractFactory("SymmioBuildersNftManager", signer)
	const contract = await upgradesApi.deployProxy(
		factory,
		[symm, nft, admin, minLockAmount, cliffDuration, vestingDuration, penaltyRate, penaltyreceiver],
		{ initializer: "initialize", ...(args.proxyadminowner ? { initialOwner: args.proxyadminowner } : {}) },
	)
	await contract.waitForDeployment()

	const managerAddress = await contract.getAddress()
	if (grantroles) {
		const roleSigner = signer ?? (await ethers.getSigners())[0]
		const roleSignerAddress = await roleSigner.getAddress()
		const symmToken = await ethers.getContractAt("Symmio", symm, roleSigner)
		const buildersNft = await ethers.getContractAt("SymmioBuildersNft", nft, roleSigner)
		const symmAdminRole = await symmToken.DEFAULT_ADMIN_ROLE()
		const nftAdminRole = await buildersNft.DEFAULT_ADMIN_ROLE()
		if (!(await symmToken.hasRole(symmAdminRole, roleSignerAddress))) throw new Error("Deployer is not a SYMM admin")
		if (!(await buildersNft.hasRole(nftAdminRole, roleSignerAddress))) throw new Error("Deployer is not an NFT admin")

		await (await symmToken.grantRole(await symmToken.MINTER_ROLE(), managerAddress)).wait()
		await (await buildersNft.grantRole(await buildersNft.MINTER_ROLE(), managerAddress)).wait()
		await (await buildersNft.grantRole(await buildersNft.BURNER_ROLE(), managerAddress)).wait()
		await (await buildersNft.grantRole(await buildersNft.PAUSER_ROLE(), managerAddress)).wait()
		await (await buildersNft.grantRole(await buildersNft.UNPAUSER_ROLE(), managerAddress)).wait()
	}

	const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(managerAddress)
	const proxyAdminAddress = await upgradesApi.erc1967.getAdminAddress(managerAddress)
	console.log(`SymmioBuildersNftManager proxy: ${managerAddress}`)
	console.log(`SymmioBuildersNftManager implementation: ${implementationAddress}`)
	console.log(`SymmioBuildersNftManager ProxyAdmin: ${proxyAdminAddress}`)
	console.log(`Required roles granted: ${grantroles}`)
	return { contract, managerAddress, implementationAddress, proxyAdminAddress }
}

export default async function deploySymmioBuildersNftManagerTask(
	args: SymmioBuildersNftManagerDeploymentArgs,
	hre: HardhatRuntimeEnvironment,
) {
	const connection = await hre.network.create()
	const upgradesApi = await upgrades(hre, connection)
	const result = await deploySymmioBuildersNftManager(args, connection.ethers, upgradesApi)
	return result.contract
}
