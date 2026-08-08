import fs from "node:fs"
import path from "node:path"

export type LedgerDiscovery = {
	expectedAddress: string
	address: string
	path: string
	candidateId: number
	scheme: string
	accountIndex?: number
	addressIndex?: number
	discoveredAt: string
}

export type NftSnapshot = {
	totalSupply: string
	paused: boolean
	transfersPaused: boolean
	tokens: Array<{
		tokenId: string
		owner: string
		amount: string
		lockTimestamp: string
		unlockingAmount: string
		name: string
	}>
	roles: Record<string, string[]>
}

export type RolloutState = {
	metadata?: {
		chainId: number
		networkName: string
		configFile: string
	}
	ledger?: Record<string, LedgerDiscovery>
	nftUpgrade?: {
		oldImplementation?: string
		newImplementation?: string
		newImplementationTxHash?: string
		newRuntimeCodeHash?: string
		upgradeTxHash?: string
		preUpgradeSnapshot?: NftSnapshot
		postUpgradeSnapshot?: NftSnapshot
		completedAt?: string
	}
	manager?: {
		proxy?: string
		implementation?: string
		implementationRuntimeCodeHash?: string
		proxyAdmin?: string
		proxyAdminOwner?: string
		deploymentTxHash?: string
		deployedAt?: string
	}
	roleGrants?: {
		nftGrantTxHashes?: string[]
		nftRolesVerifiedAt?: string
	}
}

export function loadRolloutState(file: string): RolloutState {
	if (!fs.existsSync(file)) return {}
	return JSON.parse(fs.readFileSync(file, "utf8")) as RolloutState
}

export function saveRolloutState(file: string, state: RolloutState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporaryFile = `${file}.${process.pid}.tmp`
	fs.writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8")
	fs.renameSync(temporaryFile, file)
}

export function bindRolloutState(state: RolloutState, expected: { chainId: number; networkName: string; configFile: string }): RolloutState {
	if (state.metadata) {
		if (state.metadata.chainId !== expected.chainId) {
			throw new Error(`State chainId ${state.metadata.chainId} does not match config chainId ${expected.chainId}`)
		}
		if (state.metadata.networkName !== expected.networkName) {
			throw new Error(`State network ${state.metadata.networkName} does not match config network ${expected.networkName}`)
		}
		if (state.metadata.configFile !== expected.configFile) {
			throw new Error(`State config ${state.metadata.configFile} does not match requested config ${expected.configFile}`)
		}
	}
	state.metadata = expected
	state.ledger ??= {}
	return state
}
