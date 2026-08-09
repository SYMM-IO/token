import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades"
import { config as loadEnv } from "dotenv"
import { configVariable, defineConfig } from "hardhat/config"

loadEnv()

export default defineConfig({
	plugins: [hardhatToolboxMochaEthers, hardhatUpgrades],
	solidity: {
		version: "0.8.27",
		settings: {
			evmVersion: "paris",
			metadata: {
				bytecodeHash: "none",
			},
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
			debug: {
				revertStrings: "debug",
			},
		},
	},
	networks: {
		hardhat: {
			type: "edr-simulated",
			chainType: "l1",
			chainId: 31337,
			hardfork: "osaka",
		},
		ethereum: {
			type: "http",
			chainType: "l1",
			url: process.env.RPC_ETHEREUM ?? "https://ethereum.blockpi.network/v1/rpc/public",
			accounts: [configVariable("ACCOUNT")],
		},
		base: {
			type: "http",
			chainType: "op",
			url: process.env.RPC_BASE ?? "https://base.llamarpc.com",
			accounts: [configVariable("ACCOUNT")],
		},
		polygon: {
			type: "http",
			chainType: "generic",
			url: process.env.RPC_POLYGON ?? "https://rpc.ankr.com/polygon",
			accounts: [configVariable("ACCOUNT")],
		},
	},
	verify: {
		etherscan: {
			apiKey: configVariable("ETHERSCAN_API_KEY"),
		},
	},
	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: {
			mocha: "./tests",
		},
	},
	typechain: {
		outDir: "./typechain-types",
	},
})
