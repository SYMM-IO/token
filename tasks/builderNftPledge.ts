import { task } from "hardhat/config"
import { ContractFactory, Interface, getAddress } from "ethers"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import type { StorageLayout } from "@openzeppelin/upgrades-core/dist/storage/layout"
import { getDeployData } from "@openzeppelin/hardhat-upgrades/dist/utils/deploy-impl"

export const PLEDGE_MANAGER = "contracts/builders-nft/SymmioBuildersNftManager.sol:SymmioBuildersNftManager"

export interface PledgeConfiguration {
	chainId: number
	manager: string
	nft: string
	tokenId: string
	beneficiary: string
	controller: string
	minimumPledgeCollateral: string
}

export function readPledgeConfiguration(path: string): PledgeConfiguration {
	const config = JSON.parse(readFileSync(path, "utf8")) as PledgeConfiguration
	if (config.chainId !== 8453) throw new Error("Expected Base chain 8453")
	for (const key of ["manager", "nft", "beneficiary", "controller"] as const) {
		config[key] = getAddress(config[key])
		if (BigInt(config[key]) === 0n) throw new Error(`Zero ${key}`)
	}
	if (new Set([config.manager, config.nft, config.beneficiary, config.controller]).size !== 4) throw new Error("Configuration addresses must differ")
	if (!/^\d+$/.test(config.tokenId) || !/^\d+$/.test(config.minimumPledgeCollateral) || BigInt(config.minimumPledgeCollateral) === 0n)
		throw new Error("Invalid pledge amount or ID")
	return config
}

export function pledgeTransactions(config: PledgeConfiguration, manager: Interface) {
	const nft = new Interface(["function approve(address to,uint256 tokenId)"])
	const tx = (from: string, to: string, data: string) => ({ chainId: config.chainId, from, to, value: "0", data })
	return {
		approve: tx(config.beneficiary, config.nft, nft.encodeFunctionData("approve", [config.manager, config.tokenId])),
		pledge: tx(config.beneficiary, config.manager, manager.encodeFunctionData("lockNftAsPledgeForSymmio", [config.tokenId])),
		release: tx(config.controller, config.manager, manager.encodeFunctionData("releasePledgedNft", [config.tokenId])),
		seize: tx(config.controller, config.manager, manager.encodeFunctionData("seizePledgedNft", [config.tokenId])),
	}
}

export function partialSeizureTransaction(config: PledgeConfiguration, manager: Interface, amount: string) {
	if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) throw new Error("Partial seizure amount must be a positive integer in SYMM base units")
	return {
		chainId: config.chainId,
		from: config.controller,
		to: config.manager,
		value: "0",
		data: manager.encodeFunctionData("partiallySeizePledgedNft", [config.tokenId, amount]),
	}
}

task("pledge:prepare-partial-seizure", "Prepare one unsigned Safe partial seizure; never broadcasts")
	.addParam("amount", "Represented SYMM to seize in base units; must be less than the live remainder")
	.addOptionalParam("configfile", "Public pledge configuration", "configs/carbon-builder-nft-pledge.json")
	.addOptionalParam("output", "Output Safe transaction file")
	.setAction(async ({ amount, configfile, output }, hre) => {
		await hre.run("compile")
		const config = readPledgeConfiguration(configfile)
		const factory = await hre.ethers.getContractFactory(PLEDGE_MANAGER)
		const { to, value, data } = partialSeizureTransaction(config, factory.interface, amount)
		const batch = {
			version: "1.0",
			chainId: String(config.chainId),
			createdAt: Date.now(),
			meta: {
				name: `Builder NFT ${config.tokenId}: partial seizure of ${amount} SYMM base units`,
				txBuilderVersion: "1.16.5",
				createdFromSafeAddress: config.controller,
			},
			transactions: [{ to, value, data, contractMethod: null, contractInputsValues: null }],
		}
		const path = output || `artifacts/pledge/user-initiated/partial-seizure-${config.tokenId}-${amount}.safe.json`
		mkdirSync(dirname(resolve(path)), { recursive: true })
		writeFileSync(path, JSON.stringify(batch, null, 2) + "\n")
		console.log(`Prepared ${path}; verify the live remainder before signing. No transaction broadcast or Safe proposal.`)
		return batch
	})

task("pledge:prepare", "Prepare unsigned manager upgrade inputs and pledge calldata; never broadcasts")
	.addOptionalParam("configfile", "Public pledge configuration", "configs/carbon-builder-nft-pledge.json")
	.addOptionalParam("output", "Output manifest", "artifacts/pledge/user-initiated/carbon-preparation.json")
	.setAction(async ({ configfile, output }, hre) => {
		await hre.run("compile")
		const config = readPledgeConfiguration(configfile)
		const factory = await hre.ethers.getContractFactory(PLEDGE_MANAGER)
		await hre.upgrades.validateImplementation(factory, { kind: "transparent" })
		const baseline = JSON.parse(readFileSync("tests/fixtures/builder-nft-manager-v1-storage.json", "utf8"))
		const data = await getDeployData(hre, factory, { kind: "transparent" })
		assertStorageUpgradeSafe(baseline.layout as StorageLayout, data.layout, data.fullOpts)
		const artifact = await hre.artifacts.readArtifact(PLEDGE_MANAGER)
		const build = await hre.artifacts.getBuildInfo(PLEDGE_MANAGER)
		if (!build) throw new Error("Missing compiler build information")
		const creation = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction()
		const initializationCalldata = factory.interface.encodeFunctionData("initializePledges", [config.controller, config.minimumPledgeCollateral])
		const manifest = {
			status: "prepared-not-deployed-or-upgraded",
			configuration: config,
			requiredManagerVersion: "1.1.0",
			baselineRevision: baseline.revision,
			baselineRuntimeCodeHash: baseline.runtimeCodeHash,
			compiler: `v${build.solcLongVersion}`,
			contract: PLEDGE_MANAGER,
			unsignedImplementationDeployment: { chainId: config.chainId, value: "0", data: creation.data },
			implementationConstructorArguments: [],
			initializationCalldata,
			upgradeTemplate: {
				readyToExecute: false,
				target: "VERIFIED_EXISTING_MANAGER_PROXY_ADMIN",
				method: "upgradeAndCall(address,address,bytes)",
				arguments: [config.manager, "DEPLOYED_AND_VERIFIED_IMPLEMENTATION", initializationCalldata],
			},
			transactions: pledgeTransactions(config, factory.interface),
		}
		mkdirSync(dirname(resolve(output)), { recursive: true })
		writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n")
		writeFileSync(`${output}.solc-input.json`, JSON.stringify(build.input, null, 2) + "\n")
		// Independent actions. Never batch release and seizure together.
		for (const action of ["release", "seize"] as const) {
			const { to, value, data } = manifest.transactions[action]
			writeFileSync(
				`${output}.${action}.safe.json`,
				JSON.stringify(
					{
						version: "1.0",
						chainId: String(config.chainId),
						createdAt: Date.now(),
						meta: { name: `Builder NFT pledge: ${action}`, txBuilderVersion: "1.16.5", createdFromSafeAddress: config.controller },
						transactions: [{ to, value, data, contractMethod: null, contractInputsValues: null }],
					},
					null,
					2,
				) + "\n",
			)
		}
		console.log(`Prepared ${output}; no deployment, upgrade, Safe proposal or NFT transfer`)
		return manifest
	})
