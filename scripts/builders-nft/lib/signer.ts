import { Wallet, getAddress, isHexString, type Provider, type Signer } from "ethers"

import type { PrivateKeyEnvSignerConfig } from "./config"
import { saveRolloutState, type RolloutState } from "./state"

function normalizePrivateKey(raw: string): string {
	const trimmed = raw.trim()
	return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
}

export async function resolveConfiguredSigner(options: {
	role: string
	config: PrivateKeyEnvSignerConfig
	provider: Provider
	state: RolloutState
	stateFile: string
}): Promise<Signer> {
	const expectedAddress = getAddress(options.config.address)
	const rawPrivateKey = process.env[options.config.privateKeyEnv]
	if (!rawPrivateKey) {
		throw new Error(`Set ${options.config.privateKeyEnv} to the private key for ${options.role} (${expectedAddress})`)
	}
	const privateKey = normalizePrivateKey(rawPrivateKey)
	if (!isHexString(privateKey, 32)) {
		throw new Error(`${options.config.privateKeyEnv} must contain exactly one 32-byte private key`)
	}

	const wallet = new Wallet(privateKey, options.provider)
	const actualAddress = getAddress(await wallet.getAddress())
	if (actualAddress !== expectedAddress) {
		throw new Error(`${options.config.privateKeyEnv} derives ${actualAddress}, expected ${expectedAddress} for ${options.role}`)
	}
	options.state.signers ??= {}
	options.state.signers[options.role] = {
		expectedAddress,
		address: actualAddress,
		type: "privateKeyEnv",
		privateKeyEnv: options.config.privateKeyEnv,
		verifiedAt: new Date().toISOString(),
	}
	saveRolloutState(options.stateFile, options.state)
	console.log(`[signer] verified ${options.role} ${actualAddress} from ${options.config.privateKeyEnv}`)
	return wallet
}
