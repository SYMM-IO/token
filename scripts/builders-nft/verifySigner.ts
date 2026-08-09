import hre from "hardhat"

import { loadRolloutConfig } from "./lib/config"
import { prepareRolloutContext } from "./lib/execution"
import { resolveConfiguredSigner } from "./lib/signer"

async function main() {
	const loaded = loadRolloutConfig()
	const state = await prepareRolloutContext(hre.ethers.provider, loaded)
	const signerByRole = loaded.config.signers
	const role = process.env.SIGNER_ROLE ?? "deployer"
	if (!(role in signerByRole)) throw new Error(`SIGNER_ROLE must be one of: ${Object.keys(signerByRole).join(", ")}`)
	const config = signerByRole[role as keyof typeof signerByRole]
	const signer = await resolveConfiguredSigner({ role, config, provider: hre.ethers.provider, state, stateFile: loaded.stateFile })
	console.log(`[signer] ${role}: ${await signer.getAddress()}`)
	console.log(`Signer verification metadata saved to ${loaded.stateFile}; the private key was not persisted`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
