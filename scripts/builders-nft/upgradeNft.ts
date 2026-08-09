import { Contract, Interface, getAddress, keccak256 } from "ethers"
import hre from "hardhat"
import { upgrades } from "@openzeppelin/hardhat-upgrades"

import { loadRolloutConfig } from "./lib/config.js"
import { executionEnabled, prepareRolloutContext } from "./lib/execution.js"
import { readOwnableOwner, readProxyAdmin, readProxyImplementation, requireCode, runtimeCodeHash, snapshotNft } from "./lib/onchain.js"
import { resolveConfiguredSigner } from "./lib/signer.js"
import { saveRolloutState } from "./lib/state.js"
import { findCompiledStorageLayout, loadStorageBaseline, validateNftUpgrade } from "./lib/upgradeValidation.js"

const NFT_CONTRACT = "SymmioBuildersNft"

function sameSnapshot(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

async function main() {
	const connection = await hre.network.create()
	const { ethers } = connection
	const upgradesApi = await upgrades(hre, connection)
	const loaded = loadRolloutConfig()
	const { config } = loaded
	const provider = ethers.provider
	const state = await prepareRolloutContext(provider, loaded)
	const execute = executionEnabled(config.network.chainId)

	await requireCode(provider, "SYMM", config.contracts.symm)
	await requireCode(provider, "Builders NFT proxy", config.contracts.buildersNftProxy)
	const liveImplementation = await readProxyImplementation(provider, config.contracts.buildersNftProxy)
	const proxyAdmin = await readProxyAdmin(provider, config.contracts.buildersNftProxy)
	const proxyAdminOwner = await readOwnableOwner(provider, proxyAdmin)
	if (proxyAdmin !== config.contracts.expectedBuildersNftProxyAdmin) {
		throw new Error(`Discovered NFT ProxyAdmin ${proxyAdmin}, expected ${config.contracts.expectedBuildersNftProxyAdmin}`)
	}
	if (proxyAdminOwner !== config.contracts.expectedBuildersNftProxyAdminOwner) {
		throw new Error(`Discovered ProxyAdmin owner ${proxyAdminOwner}, expected ${config.contracts.expectedBuildersNftProxyAdminOwner}`)
	}
	console.log(
		JSON.stringify(
			{
				liveProxy: config.contracts.buildersNftProxy,
				liveImplementation,
				proxyAdmin,
				proxyAdminOwner,
			},
			null,
			2,
		),
	)

	const baseline = loadStorageBaseline(loaded.storageBaselineFile)
	const artifact = await hre.artifacts.readArtifact(NFT_CONTRACT)
	const updatedLayout = findCompiledStorageLayout(baseline.contract)
	const validation = validateNftUpgrade({
		baseline,
		updatedLayout,
		updatedAbi: artifact.abi,
		acceptedRemovedFunctions: config.upgrade.acceptedRemovedFunctions,
	})
	console.log("NFT upgrade validation:")
	console.log(JSON.stringify(validation, null, 2))
	if (!validation.ok) {
		throw new Error(
			"NFT upgrade validation failed. Restore removed ABI functions or list an explicitly accepted signature in upgrade.acceptedRemovedFunctions.",
		)
	}

	const expectedOldImplementation = getAddress(config.contracts.expectedBuildersNftImplementation)
	const savedNewImplementation = state.nftUpgrade?.newImplementation ? getAddress(state.nftUpgrade.newImplementation) : undefined
	if (liveImplementation !== expectedOldImplementation && liveImplementation !== savedNewImplementation) {
		throw new Error(`NFT implementation ${liveImplementation} is neither the configured baseline nor the saved rollout implementation`)
	}
	if (liveImplementation === expectedOldImplementation) {
		const liveCodeHash = await runtimeCodeHash(provider, liveImplementation)
		if (liveCodeHash !== baseline.runtimeCodeHash) {
			throw new Error(`Live NFT runtime hash ${liveCodeHash} does not match baseline ${baseline.runtimeCodeHash}`)
		}
	}

	const currentSnapshot = await snapshotNft(provider, config.contracts.buildersNftProxy)
	state.nftUpgrade ??= {}
	state.nftUpgrade.oldImplementation ??= expectedOldImplementation
	state.nftUpgrade.preUpgradeSnapshot ??= currentSnapshot
	if (liveImplementation === expectedOldImplementation && !sameSnapshot(state.nftUpgrade.preUpgradeSnapshot, currentSnapshot)) {
		throw new Error("Current NFT state differs from the saved pre-upgrade snapshot")
	}
	saveRolloutState(loaded.stateFile, state)

	const newRuntimeCodeHash = keccak256(artifact.deployedBytecode)
	console.log(
		JSON.stringify(
			{
				mode: execute ? "execute" : "preview",
				proxy: config.contracts.buildersNftProxy,
				liveImplementation,
				proxyAdmin,
				proxyAdminOwner,
				implementationDeployer: config.signers.deployer.address,
				newRuntimeCodeHash,
				stateFile: loaded.stateFile,
			},
			null,
			2,
		),
	)
	if (!execute) {
		console.log(`Preview only. Set EXECUTE=true and CONFIRM_CHAIN_ID=${config.network.chainId} to deploy and upgrade.`)
		return
	}

	let newImplementation = savedNewImplementation
	if (!newImplementation) {
		const deployer = await resolveConfiguredSigner({
			role: "deployer",
			config: config.signers.deployer,
			provider,
			state,
			stateFile: loaded.stateFile,
		})
		const factory = await ethers.getContractFactory(NFT_CONTRACT, deployer)
		await upgradesApi.validateImplementation(factory, { kind: "transparent" })
		const implementation = await factory.deploy()
		const deployment = implementation.deploymentTransaction()
		await implementation.waitForDeployment()
		newImplementation = getAddress(await implementation.getAddress())
		state.nftUpgrade.newImplementation = newImplementation
		state.nftUpgrade.newImplementationTxHash = deployment?.hash
		state.nftUpgrade.newRuntimeCodeHash = newRuntimeCodeHash
		saveRolloutState(loaded.stateFile, state)
		console.log(`NFT implementation deployed: ${newImplementation}`)
	}
	const deployedHash = await runtimeCodeHash(provider, newImplementation)
	if (deployedHash !== newRuntimeCodeHash) {
		throw new Error(`Deployed implementation runtime hash ${deployedHash} does not match artifact ${newRuntimeCodeHash}`)
	}

	const implementationBeforeUpgrade = await readProxyImplementation(provider, config.contracts.buildersNftProxy)
	if (implementationBeforeUpgrade !== newImplementation) {
		if (implementationBeforeUpgrade !== expectedOldImplementation) {
			throw new Error(`NFT proxy changed to unexpected implementation ${implementationBeforeUpgrade}`)
		}
		const adminSigner = await resolveConfiguredSigner({
			role: "nftProxyAdminOwner",
			config: config.signers.nftProxyAdminOwner,
			provider,
			state,
			stateFile: loaded.stateFile,
		})
		if ((await adminSigner.getAddress()) !== proxyAdminOwner)
			throw new Error("Configured NFT admin signer does not match discovered ProxyAdmin owner")
		const proxyAdminContract = new Contract(
			proxyAdmin,
			["function upgradeAndCall(address proxy,address implementation,bytes data) payable"],
			adminSigner,
		)
		const upgradeData = new Interface(["function upgradeAndCall(address proxy,address implementation,bytes data)"]).encodeFunctionData(
			"upgradeAndCall",
			[config.contracts.buildersNftProxy, newImplementation, "0x"],
		)
		console.log(`ProxyAdmin calldata: ${upgradeData}`)
		const transaction = await proxyAdminContract.upgradeAndCall(config.contracts.buildersNftProxy, newImplementation, "0x")
		await transaction.wait()
		state.nftUpgrade.upgradeTxHash = transaction.hash
		saveRolloutState(loaded.stateFile, state)
	}

	const finalImplementation = await readProxyImplementation(provider, config.contracts.buildersNftProxy)
	if (finalImplementation !== newImplementation) throw new Error(`NFT proxy points to ${finalImplementation}, expected ${newImplementation}`)
	const postUpgradeSnapshot = await snapshotNft(provider, config.contracts.buildersNftProxy)
	if (!sameSnapshot(state.nftUpgrade.preUpgradeSnapshot, postUpgradeSnapshot)) {
		throw new Error("NFT storage/state snapshot changed across the implementation upgrade")
	}
	state.nftUpgrade.postUpgradeSnapshot = postUpgradeSnapshot
	state.nftUpgrade.completedAt = new Date().toISOString()
	saveRolloutState(loaded.stateFile, state)
	console.log(`NFT upgrade verified and recorded in ${loaded.stateFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
