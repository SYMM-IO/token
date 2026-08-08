import hre from "hardhat"

import { loadRolloutConfig } from "./lib/config"
import { prepareRolloutContext } from "./lib/execution"
import { resolveLedgerSigner } from "./lib/ledger"

async function main() {
	const loaded = loadRolloutConfig()
	const state = await prepareRolloutContext(hre.ethers.provider, loaded)
	const signerByRole = {
		deployer: loaded.config.signers.deployer.address,
		nftProxyAdminOwner: loaded.config.signers.nftProxyAdminOwner.address,
	}
	const role = process.env.LEDGER_ROLE ?? "deployer"
	if (!(role in signerByRole)) throw new Error(`LEDGER_ROLE must be one of: ${Object.keys(signerByRole).join(", ")}`)
	const address = signerByRole[role as keyof typeof signerByRole]

	console.log(`Scanning Ledger candidates for ${role} on ${loaded.config.network.name} (${loaded.config.network.chainId})`)
	const signer = await resolveLedgerSigner({
		role,
		expectedAddress: address,
		provider: hre.ethers.provider,
		scan: loaded.config.ledger.scan,
		state,
		stateFile: loaded.stateFile,
	})
	console.log(`[ledger] ${role}: ${await signer.getAddress()}`)
	console.log(`Ledger candidate IDs and derivation paths saved to ${loaded.stateFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
