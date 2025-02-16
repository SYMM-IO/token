import "@nomicfoundation/hardhat-toolbox"
import "@nomicfoundation/hardhat-verify"
import "@openzeppelin/hardhat-upgrades"
import "@typechain/hardhat"
import * as dotenv from "dotenv"
import "hardhat-gas-reporter"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"

import "./tasks/SymmAllocationClaimer"
import "./tasks/symmioToken"

dotenv.config()

const accounts_list: any = [process.env.ACCOUNT]

export const config: HardhatUserConfig = {
	defaultNetwork: "hardhat",
	gasReporter: {
		currency: "USD",
		enabled: true,
		excludeContracts: [],
		src: "./contracts",
	},
	solidity: {
		version: "0.8.27",
		settings: {
			metadata: {
				// Not including the metadata hash
				// https://github.com/paulrberg/hardhat-template/issues/31
				bytecodeHash: "none",
			},
			// Disable the optimizer when debugging
			// https://hardhat.org/hardhat-network/#solidity-optimizer-support
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
			// forking: {
			// 	url: "",
			// 	blockNumber: 67892234,
			// },
		},
		ethereum: {
			url: "https://ethereum.blockpi.network/v1/rpc/public",
			accounts: accounts_list,
		},

		polygon: {
			url: "https://rpc.ankr.com/polygon",
			accounts: accounts_list,
		},
	},
	etherscan: {
		apiKey: {
			polygon: "",
		},
		customChains: [],
	},
	paths: {
		artifacts: "./artifacts",
		cache: "./cache",
		sources: "./contracts",
		tests: "./tests",
	},
}

export default config
