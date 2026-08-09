import { Contract, ZeroHash, getAddress, keccak256 } from "ethers"
import hre from "hardhat"
import { upgrades } from "@openzeppelin/hardhat-upgrades"

import { deploySymmioBuildersNftManager } from "../../tasks/symmioBuildersNftManager.js"
import { loadRolloutConfig, requireManagerDeploymentConfig } from "./lib/config.js"
import { executionEnabled, prepareRolloutContext } from "./lib/execution.js"
import { readOwnableOwner, readProxyAdmin, readProxyImplementation, requireCode, runtimeCodeHash } from "./lib/onchain.js"
import { resolveConfiguredSigner } from "./lib/signer.js"
import { saveRolloutState } from "./lib/state.js"

async function verifyManager(proxy: string, loaded: ReturnType<typeof loadRolloutConfig>, provider: import("ethers").Provider) {
	const { config } = loaded
	const expected = requireManagerDeploymentConfig(config)
	const manager = new Contract(
		proxy,
		[
			"function SYMM() view returns (address)",
			"function nftContract() view returns (address)",
			"function minLockAmount() view returns (uint256)",
			"function cliffDuration() view returns (uint256)",
			"function vestingDuration() view returns (uint256)",
			"function lockedClaimPenaltyRate() view returns (uint256)",
			"function lockedClaimPenaltyReceiver() view returns (address)",
			"function hasRole(bytes32,address) view returns (bool)",
			"function SETTER_ROLE() view returns (bytes32)",
			"function PAUSER_ROLE() view returns (bytes32)",
			"function UNPAUSER_ROLE() view returns (bytes32)",
			"function OPERATOR_ROLE() view returns (bytes32)",
			"function MINTER_ROLE() view returns (bytes32)",
		],
		provider,
	)
	const checks: Array<[string, string, string]> = [
		["SYMM", getAddress(await manager.SYMM()), config.contracts.symm],
		["nftContract", getAddress(await manager.nftContract()), config.contracts.buildersNftProxy],
		["minLockAmount", (await manager.minLockAmount()).toString(), expected.minLockAmount.toString()],
		["cliffDuration", (await manager.cliffDuration()).toString(), expected.cliffDuration.toString()],
		["vestingDuration", (await manager.vestingDuration()).toString(), expected.vestingDuration.toString()],
		["lockedClaimPenaltyRate", (await manager.lockedClaimPenaltyRate()).toString(), expected.penaltyRate.toString()],
		["lockedClaimPenaltyReceiver", getAddress(await manager.lockedClaimPenaltyReceiver()), expected.penaltyReceiver],
	]
	for (const [label, actual, wanted] of checks) {
		if (actual !== wanted) throw new Error(`Manager ${label} is ${actual}, expected ${wanted}`)
	}
	if (!(await manager.hasRole(ZeroHash, expected.admin))) throw new Error(`Manager admin role was not granted to ${expected.admin}`)
	for (const roleName of ["SETTER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE", "OPERATOR_ROLE", "MINTER_ROLE"]) {
		const role = await manager[roleName]()
		if (!(await manager.hasRole(role, expected.admin))) throw new Error(`Manager ${roleName} was not granted to ${expected.admin}`)
	}
}

async function main() {
	const connection = await hre.network.create()
	const { ethers } = connection
	const upgradesApi = await upgrades(hre, connection)
	const loaded = loadRolloutConfig()
	const { config } = loaded
	const managerConfig = requireManagerDeploymentConfig(config)
	const provider = ethers.provider
	const state = await prepareRolloutContext(provider, loaded)
	const execute = executionEnabled(config.network.chainId)
	await requireCode(provider, "SYMM", config.contracts.symm)
	await requireCode(provider, "Builders NFT proxy", config.contracts.buildersNftProxy)

	const factory = await ethers.getContractFactory("SymmioBuildersNftManager")
	await upgradesApi.validateImplementation(factory, { kind: "transparent" })
	const artifact = await hre.artifacts.readArtifact("SymmioBuildersNftManager")
	const implementationRuntimeCodeHash = keccak256(artifact.deployedBytecode)
	console.log(
		JSON.stringify(
			{
				mode: execute ? "execute" : "preview",
				deployer: config.signers.deployer.address,
				proxyAdminOwner: managerConfig.proxyAdminOwner,
				implementationRuntimeCodeHash,
				initializer: {
					symm: config.contracts.symm,
					nft: config.contracts.buildersNftProxy,
					admin: managerConfig.admin,
					minLockAmount: managerConfig.minLockAmount.toString(),
					cliffDuration: managerConfig.cliffDuration.toString(),
					vestingDuration: managerConfig.vestingDuration.toString(),
					penaltyRate: managerConfig.penaltyRate.toString(),
					penaltyReceiver: managerConfig.penaltyReceiver,
				},
				stateFile: loaded.stateFile,
			},
			null,
			2,
		),
	)

	if (state.manager?.proxy) {
		await requireCode(provider, "Saved manager proxy", state.manager.proxy)
		await verifyManager(state.manager.proxy, loaded, provider)
		const implementation = await readProxyImplementation(provider, state.manager.proxy)
		const proxyAdmin = await readProxyAdmin(provider, state.manager.proxy)
		const owner = await readOwnableOwner(provider, proxyAdmin)
		await requireCode(provider, "Saved manager implementation", implementation)
		await requireCode(provider, "Saved manager ProxyAdmin", proxyAdmin)
		if (implementation !== state.manager.implementation) throw new Error("Saved manager implementation no longer matches its proxy")
		if (proxyAdmin !== state.manager.proxyAdmin) throw new Error("Saved manager ProxyAdmin no longer matches its proxy")
		if (owner !== managerConfig.proxyAdminOwner) throw new Error(`Manager ProxyAdmin owner is ${owner}, expected ${managerConfig.proxyAdminOwner}`)
		const savedRuntimeHash = await runtimeCodeHash(provider, implementation)
		if (savedRuntimeHash !== implementationRuntimeCodeHash) {
			throw new Error(`Manager implementation runtime hash is ${savedRuntimeHash}, expected ${implementationRuntimeCodeHash}`)
		}
		console.log(`Existing manager deployment verified: ${state.manager.proxy}`)
		return
	}
	if (!execute) {
		console.log(`Preview only. Set EXECUTE=true and CONFIRM_CHAIN_ID=${config.network.chainId} to deploy.`)
		return
	}

	const deployer = await resolveConfiguredSigner({
		role: "deployer",
		config: config.signers.deployer,
		provider,
		state,
		stateFile: loaded.stateFile,
	})
	const deployment = await deploySymmioBuildersNftManager(
		{
			symm: config.contracts.symm,
			nft: config.contracts.buildersNftProxy,
			admin: managerConfig.admin,
			minlockamount: managerConfig.minLockAmount.toString(),
			cliffduration: managerConfig.cliffDuration.toString(),
			vestingduration: managerConfig.vestingDuration.toString(),
			penaltyrate: managerConfig.penaltyRate.toString(),
			penaltyreceiver: managerConfig.penaltyReceiver,
			proxyadminowner: managerConfig.proxyAdminOwner,
			grantroles: false,
		},
		ethers,
		upgradesApi,
		deployer,
	)
	const proxyAdminOwner = await readOwnableOwner(provider, deployment.proxyAdminAddress)
	if (proxyAdminOwner !== managerConfig.proxyAdminOwner) {
		throw new Error(`Deployed manager ProxyAdmin owner is ${proxyAdminOwner}, expected ${managerConfig.proxyAdminOwner}`)
	}
	const deployedRuntimeHash = await runtimeCodeHash(provider, deployment.implementationAddress)
	if (deployedRuntimeHash !== implementationRuntimeCodeHash) {
		throw new Error(`Deployed manager runtime hash is ${deployedRuntimeHash}, expected ${implementationRuntimeCodeHash}`)
	}
	await verifyManager(deployment.managerAddress, loaded, provider)
	state.manager = {
		proxy: deployment.managerAddress,
		implementation: deployment.implementationAddress,
		implementationRuntimeCodeHash,
		proxyAdmin: deployment.proxyAdminAddress,
		proxyAdminOwner,
		deploymentTxHash: deployment.contract.deploymentTransaction()?.hash,
		deployedAt: new Date().toISOString(),
	}
	saveRolloutState(loaded.stateFile, state)
	console.log(`Manager deployment verified and recorded in ${loaded.stateFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
