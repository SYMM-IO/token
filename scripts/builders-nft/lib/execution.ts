import type { Provider } from "ethers"

import type { LoadedRolloutConfig } from "./config"
import { bindRolloutState, loadRolloutState, saveRolloutState } from "./state"

export async function prepareRolloutContext(provider: Provider, loaded: LoadedRolloutConfig) {
	const network = await provider.getNetwork()
	if (Number(network.chainId) !== loaded.config.network.chainId) {
		throw new Error(`Connected chain ${network.chainId} does not match config chain ${loaded.config.network.chainId}`)
	}
	const state = bindRolloutState(loadRolloutState(loaded.stateFile), {
		chainId: loaded.config.network.chainId,
		networkName: loaded.config.network.name,
		configFile: loaded.configFile,
	})
	saveRolloutState(loaded.stateFile, state)
	return state
}

export function executionEnabled(chainId: number): boolean {
	if (process.env.EXECUTE !== "true") return false
	if (process.env.CONFIRM_CHAIN_ID !== String(chainId)) {
		throw new Error(`Set CONFIRM_CHAIN_ID=${chainId} together with EXECUTE=true to send transactions`)
	}
	return true
}
