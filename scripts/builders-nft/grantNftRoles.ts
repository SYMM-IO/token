import { Contract, getAddress } from "ethers"
import hre from "hardhat"

import { loadRolloutConfig } from "./lib/config"
import { executionEnabled, prepareRolloutContext } from "./lib/execution"
import { resolveLedgerSigner } from "./lib/ledger"
import { loadRoleTransactions } from "./lib/roleTransactions"
import { saveRolloutState } from "./lib/state"

const accessControlAbi = ["function grantRole(bytes32 role,address account)", "function hasRole(bytes32 role,address account) view returns (bool)"]

async function main() {
	const loaded = loadRolloutConfig()
	const { config } = loaded
	const state = await prepareRolloutContext(hre.ethers.provider, loaded)
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
	const signer = await resolveLedgerSigner({
		role: "nftProxyAdminOwner",
		expectedAddress: plan.nftAdmin.address,
		provider: hre.ethers.provider,
		scan: config.ledger.scan,
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
