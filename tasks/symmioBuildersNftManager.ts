import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"

task("deploy:SymmioBuildersNftManager", "Deploys the SymmioBuildersNftManager contract")
	.addParam("symm", "SYMM token address")
	.addParam("nft", "SymmioBuildersNft proxy address")
	.addParam("admin", "Address receiving all manager administration roles")
	.addParam("minlockamount", "Minimum SYMM amount required to mint an NFT, in wei")
	.addParam("cliffduration", "Unlock cliff duration, in seconds")
	.addParam("vestingduration", "Linear vesting duration, in seconds")
	.addParam("penaltyrate", "Early-claim penalty scaled by 1e18")
	.addParam("penaltyreceiver", "Address receiving early-claim penalties")
	.addParam("maxactiveunlockrequests", "Maximum active unlock requests allowed per user")
	.addFlag("grantroles", "Grant the deployed manager its required SYMM and NFT roles from the deployer")
	.setAction(async (args, { ethers, upgrades }: HardhatRuntimeEnvironment) => {
		const {
			symm,
			nft,
			admin,
			minlockamount,
			cliffduration,
			vestingduration,
			penaltyrate,
			penaltyreceiver,
			maxactiveunlockrequests,
			grantroles,
		} = args
		const addresses = { symm, nft, admin, penaltyreceiver }
		for (const [label, value] of Object.entries(addresses)) {
			if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`Invalid ${label} address`)
		}

		const minLockAmount = BigInt(minlockamount)
		const cliffDuration = BigInt(cliffduration)
		const vestingDuration = BigInt(vestingduration)
		const penaltyRate = BigInt(penaltyrate)
		const maxActiveUnlockRequests = BigInt(maxactiveunlockrequests)
		if (minLockAmount <= 0n) throw new Error("minlockamount must be greater than zero")
		if (cliffDuration <= 0n) throw new Error("cliffduration must be greater than zero")
		if (vestingDuration <= 0n) throw new Error("vestingduration must be greater than zero")
		if (penaltyRate < 0n || penaltyRate > ethers.parseUnits("1", 18)) throw new Error("penaltyrate must be between 0 and 1e18")
		if (maxActiveUnlockRequests <= 0n) throw new Error("maxactiveunlockrequests must be greater than zero")

		console.log("deploy:SymmioBuildersNftManager")
		console.table({
			symm,
			nft,
			admin,
			minLockAmount,
			cliffDuration,
			vestingDuration,
			penaltyRate,
			penaltyreceiver,
			maxActiveUnlockRequests,
			grantroles,
		})

		const factory = await ethers.getContractFactory("SymmioBuildersNftManager")
		const contract = await upgrades.deployProxy(
			factory,
			[
				symm,
				nft,
				admin,
				minLockAmount,
				cliffDuration,
				vestingDuration,
				penaltyRate,
				penaltyreceiver,
				maxActiveUnlockRequests,
			],
			{ initializer: "initialize" },
		)
		await contract.waitForDeployment()

		const managerAddress = await contract.getAddress()
		if (grantroles) {
			const [deployer] = await ethers.getSigners()
			const symmToken = await ethers.getContractAt("Symmio", symm)
			const buildersNft = await ethers.getContractAt("SymmioBuildersNft", nft)
			const symmAdminRole = await symmToken.DEFAULT_ADMIN_ROLE()
			const nftAdminRole = await buildersNft.DEFAULT_ADMIN_ROLE()
			if (!(await symmToken.hasRole(symmAdminRole, deployer.address))) throw new Error("Deployer is not a SYMM admin")
			if (!(await buildersNft.hasRole(nftAdminRole, deployer.address))) throw new Error("Deployer is not an NFT admin")

			await (await symmToken.grantRole(await symmToken.MINTER_ROLE(), managerAddress)).wait()
			await (await buildersNft.grantRole(await buildersNft.MINTER_ROLE(), managerAddress)).wait()
			await (await buildersNft.grantRole(await buildersNft.BURNER_ROLE(), managerAddress)).wait()
			await (await buildersNft.grantRole(await buildersNft.PAUSER_ROLE(), managerAddress)).wait()
			await (await buildersNft.grantRole(await buildersNft.UNPAUSER_ROLE(), managerAddress)).wait()
		}

		const implementationAddress = await upgrades.erc1967.getImplementationAddress(managerAddress)
		console.log(`SymmioBuildersNftManager proxy: ${managerAddress}`)
		console.log(`SymmioBuildersNftManager implementation: ${implementationAddress}`)
		console.log(`Required roles granted: ${grantroles}`)
		return contract
	})
