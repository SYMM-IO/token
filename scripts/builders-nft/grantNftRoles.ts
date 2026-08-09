import { Contract, getAddress } from "ethers"
import hre from "hardhat"

import { loadRolloutConfig } from "./lib/config.js"
import { executionEnabled, prepareRolloutContext } from "./lib/execution.js"
import { loadRoleTransactions } from "./lib/roleTransactions.js"
import { resolveConfiguredSigner } from "./lib/signer.js"
import { saveRolloutState } from "./lib/state.js"

const accessControlAbi = ["function grantRole(bytes32 role,address account)", "function hasRole(bytes32 role,address account) view returns (bool)"]

async function main() {
	const { ethers } = await hre.network.create()
	const provider = ethers.provider
	const loaded = loadRolloutConfig()
	const { config } = loaded
	const state = await prepareRolloutContext(provider, loaded)
	const execute = executionEnabled(config.network.chainId)
	const plan = loadRoleTransactions(loaded.roleTransactionsFile)
	if (plan.chainId !== config.network.chainId || plan.networkName !== config.network.name) throw new Error("Role plan network does not match config")
	if (!state.manager?.proxy || getAddress(plan.manager) !== getAddress(state.manager.proxy))
		throw new Error("Role plan manager does not match rollout state")
	if (getAddress(plan.nftAdmin.address) !== config.signers.nftProxyAdminOwner.address) throw new Error("Role plan NFT admin does not match config")

	console.log(JSON.stringify({ mode: execute ? "execute" : "preview", ...plan.nftAdmin }, null, 2))
	if (!execute) {
		console.log(`Preview only. Set EXECUTE=true and CONFIRM_CHAIN_ID=${config.network.chainId} to grant the NFT roles.`)
		return
	}
	const signer = await resolveConfiguredSigner({
		role: "nftProxyAdminOwner",
		config: config.signers.nftProxyAdminOwner,
		provider,
		state,
		stateFile: loaded.stateFile,
	})
	const nft = new Contract(config.contracts.buildersNftProxy, accessControlAbi, signer)
	const hashes: string[] = []
	for (const prepared of plan.nftAdmin.transactions) {
		if (getAddress(prepared.to) !== config.contracts.buildersNftProxy || getAddress(prepared.from ?? "") !== plan.nftAdmin.address) {
			throw new Error(`Prepared transaction ${prepared.id} does not match the configured NFT authority`)
		}
		const decoded = nft.interface.decodeFunctionData("grantRole", prepared.data)
		if (getAddress(decoded.account) !== getAddress(plan.manager)) throw new Error(`${prepared.id} grants the role to an unexpected account`)
		if (await nft.hasRole(decoded.role, plan.manager)) {
			console.log(`${prepared.id}: role already granted`)
			continue
		}
		const transaction = await signer.sendTransaction({ to: prepared.to, value: BigInt(prepared.value), data: prepared.data })
		await transaction.wait()
		hashes.push(transaction.hash)
		if (!(await nft.hasRole(decoded.role, plan.manager))) throw new Error(`${prepared.id} was mined but the role is still missing`)
	}
	state.roleGrants ??= {}
	state.roleGrants.nftGrantTxHashes = [...(state.roleGrants.nftGrantTxHashes ?? []), ...hashes]
	state.roleGrants.nftRolesVerifiedAt = new Date().toISOString()
	saveRolloutState(loaded.stateFile, state)
	console.log(`NFT roles verified and recorded in ${loaded.stateFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
