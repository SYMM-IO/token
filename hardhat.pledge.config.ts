import { HardhatUserConfig } from "hardhat/config"
import config from "./hardhat.config"

const forkUrl = process.env.BASE_FORK_RPC_URL
const forkBlock = Number(process.env.BASE_FORK_BLOCK)
if (forkUrl && (!Number.isSafeInteger(forkBlock) || forkBlock <= 0)) {
	throw new Error("BASE_FORK_BLOCK must be a positive integer when BASE_FORK_RPC_URL is set")
}

// Test/read-only configuration. No Base signing accounts are configured.
const pledgeConfig: HardhatUserConfig = {
	...config,
	gasReporter: { ...config.gasReporter, enabled: false },
	networks: {
		hardhat: {
			chainId: forkUrl ? 8453 : 31337,
			// Hardhat 2.22 has no Base history: test Paris bytecode in a local Cancun EVM.
			// This is a state snapshot simulation, not Base consensus or fee replay.
			hardfork: "cancun",
			...(forkUrl ? { chains: { 8453: { hardforkHistory: { cancun: forkBlock } } }, forking: { url: forkUrl, blockNumber: forkBlock } } : {}),
		},
		base: { chainId: 8453, url: process.env.BASE_RPC_URL || "https://mainnet.base.org", accounts: [] },
	},
}
export default pledgeConfig
