import fs from "node:fs"
import path from "node:path"

import { ethers } from "ethers"

export type PrivateKeyEnvSignerConfig = {
	type: "privateKeyEnv"
	address: string
	privateKeyEnv: string
}

export type BuildersNftRolloutConfig = {
	schemaVersion: number
	network: {
		name: string
		chainId: number
	}
	files: {
		state: string
		storageBaseline: string
		roleTransactions: string
	}
	contracts: {
		symm: string
		buildersNftProxy: string
		expectedBuildersNftImplementation: string
		expectedBuildersNftProxyAdmin: string
		expectedBuildersNftProxyAdminOwner: string
		expectedSymmAdmin: string
	}
	signers: {
		deployer: PrivateKeyEnvSignerConfig
		nftProxyAdminOwner: PrivateKeyEnvSignerConfig
	}
	upgrade: {
		acceptedRemovedFunctions: string[]
	}
	manager: {
		admin: string | null
		proxyAdminOwner: string | null
		minLockAmount: string | null
		cliffDuration: string | null
		vestingDuration: string | null
		penaltyRate: string | null
		penaltyReceiver: string | null
	}
	roles: {
		timelockPredecessor: string
		timelockSaltLabel: string
		logScanChunkSize: number
	}
}

export type LoadedRolloutConfig = {
	config: BuildersNftRolloutConfig
	configFile: string
	stateFile: string
	storageBaselineFile: string
	roleTransactionsFile: string
}

function requireAddress(value: unknown, label: string): string {
	if (typeof value !== "string" || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
		throw new Error(`${label} must be a non-zero address`)
	}
	return ethers.getAddress(value)
}

function requireCount(value: unknown, label: string): number {
	if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
	return Number(value)
}

function requirePrivateKeyEnvSigner(value: unknown, label: string): PrivateKeyEnvSignerConfig {
	if (!value || typeof value !== "object") throw new Error(`${label} is required`)
	const signer = value as Partial<PrivateKeyEnvSignerConfig>
	if (signer.type !== "privateKeyEnv") throw new Error(`${label}.type must be privateKeyEnv`)
	if (typeof signer.privateKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(signer.privateKeyEnv)) {
		throw new Error(`${label}.privateKeyEnv must be an uppercase environment-variable name`)
	}
	return {
		type: "privateKeyEnv",
		address: requireAddress(signer.address, `${label}.address`),
		privateKeyEnv: signer.privateKeyEnv,
	}
}

function requireRelativeFile(configFile: string, value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty path`)
	return path.resolve(path.dirname(configFile), value)
}

export function loadRolloutConfig(configFileOverride?: string): LoadedRolloutConfig {
	const requestedFile = configFileOverride ?? process.env.BUILDERS_NFT_CONFIG
	if (!requestedFile) throw new Error("BUILDERS_NFT_CONFIG must point to a rollout JSON file")

	const configFile = path.resolve(requestedFile)
	if (!fs.existsSync(configFile)) throw new Error(`Rollout config does not exist: ${configFile}`)
	const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as BuildersNftRolloutConfig

	if (config.schemaVersion !== 2) throw new Error(`Unsupported rollout config schemaVersion: ${config.schemaVersion}`)
	if (!config.network?.name) throw new Error("network.name is required")
	if (!Number.isInteger(config.network.chainId) || config.network.chainId <= 0) throw new Error("network.chainId must be a positive integer")

	config.contracts.symm = requireAddress(config.contracts?.symm, "contracts.symm")
	config.contracts.buildersNftProxy = requireAddress(config.contracts?.buildersNftProxy, "contracts.buildersNftProxy")
	config.contracts.expectedBuildersNftImplementation = requireAddress(
		config.contracts?.expectedBuildersNftImplementation,
		"contracts.expectedBuildersNftImplementation",
	)
	config.contracts.expectedBuildersNftProxyAdmin = requireAddress(
		config.contracts?.expectedBuildersNftProxyAdmin,
		"contracts.expectedBuildersNftProxyAdmin",
	)
	config.contracts.expectedBuildersNftProxyAdminOwner = requireAddress(
		config.contracts?.expectedBuildersNftProxyAdminOwner,
		"contracts.expectedBuildersNftProxyAdminOwner",
	)
	config.contracts.expectedSymmAdmin = requireAddress(config.contracts?.expectedSymmAdmin, "contracts.expectedSymmAdmin")
	config.signers.deployer = requirePrivateKeyEnvSigner(config.signers?.deployer, "signers.deployer")
	config.signers.nftProxyAdminOwner = requirePrivateKeyEnvSigner(config.signers?.nftProxyAdminOwner, "signers.nftProxyAdminOwner")
	if (config.signers.nftProxyAdminOwner.address !== config.contracts.expectedBuildersNftProxyAdminOwner) {
		throw new Error("signers.nftProxyAdminOwner.address must match contracts.expectedBuildersNftProxyAdminOwner")
	}

	if (!Array.isArray(config.upgrade?.acceptedRemovedFunctions)) throw new Error("upgrade.acceptedRemovedFunctions must be an array")
	if (!ethers.isHexString(config.roles?.timelockPredecessor, 32)) throw new Error("roles.timelockPredecessor must be bytes32")
	if (!config.roles.timelockSaltLabel) throw new Error("roles.timelockSaltLabel is required")
	config.roles.logScanChunkSize = requireCount(config.roles.logScanChunkSize, "roles.logScanChunkSize")
	if (config.roles.logScanChunkSize === 0) throw new Error("roles.logScanChunkSize must be greater than zero")

	return {
		config,
		configFile,
		stateFile: requireRelativeFile(configFile, config.files?.state, "files.state"),
		storageBaselineFile: requireRelativeFile(configFile, config.files?.storageBaseline, "files.storageBaseline"),
		roleTransactionsFile: requireRelativeFile(configFile, config.files?.roleTransactions, "files.roleTransactions"),
	}
}

function requireManagerAddress(value: string | null, label: string): string {
	return requireAddress(value, `manager.${label}`)
}

function requireManagerUint(value: string | null, label: string, allowZero = false): bigint {
	if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`manager.${label} must be a base-10 integer string`)
	const parsed = BigInt(value)
	if (parsed < 0n || (!allowZero && parsed === 0n)) throw new Error(`manager.${label} must be ${allowZero ? "non-negative" : "positive"}`)
	return parsed
}

export function requireManagerDeploymentConfig(config: BuildersNftRolloutConfig) {
	const penaltyRate = requireManagerUint(config.manager.penaltyRate, "penaltyRate", true)
	if (penaltyRate > ethers.parseUnits("1", 18)) throw new Error("manager.penaltyRate must not exceed 1e18")
	return {
		admin: requireManagerAddress(config.manager.admin, "admin"),
		proxyAdminOwner: requireManagerAddress(config.manager.proxyAdminOwner, "proxyAdminOwner"),
		minLockAmount: requireManagerUint(config.manager.minLockAmount, "minLockAmount"),
		cliffDuration: requireManagerUint(config.manager.cliffDuration, "cliffDuration"),
		vestingDuration: requireManagerUint(config.manager.vestingDuration, "vestingDuration"),
		penaltyRate,
		penaltyReceiver: requireManagerAddress(config.manager.penaltyReceiver, "penaltyReceiver"),
	}
}
