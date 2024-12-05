import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "./.env") });

// Ensure that we have all the environment variables we need.
const privateKey: string | undefined = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error("Please set your PRIVATE_KEY in a .env file");

const privateKeysStr: string | undefined = process.env.PRIVATE_KEYS_STR;
const privateKeyList: string[] = privateKeysStr?.split(",") || [];

const baseApiKey: string = process.env.BASE_API_KEY || "";
const arbitrumApiKey: string = process.env.ARBITRUM_API_KEY || "";
const ethApiKey: string = process.env.ETHER_API_KEY || "";
const drpcKey: string = process.env.DRPC_KEY || "";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  gasReporter: {
    currency: "USD",
    enabled: true,
    excludeContracts: [],
    src: "./contracts",
  },
  networks: {
    hardhat: {
      // forking: {
      //   url: "",
      // },
      allowUnlimitedContractSize: false,
    },
    base: {
      url: `https://lb.drpc.org/ogrpc?network=base&dkey=${drpcKey}`,
      accounts: [privateKey],
    },
    arbitrum: {
      url: `https://lb.drpc.org/ogrpc?network=arbitrum&dkey=${drpcKey}`,
      accounts: [privateKey],
    },
    ethereum: {
      url: `https://lb.drpc.org/ogrpc?network=ethereum&dkey=${drpcKey}`,
      accounts: [privateKey],
    },
  },
  etherscan: {
    apiKey: {
      arbitrumOne: arbitrumApiKey,
      base: baseApiKey,
      mainnet: ethApiKey,
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: `https://api.basescan.org/api?apiKey=${baseApiKey}`,
          browserURL: "https://basescan.org",
        },
      },
      // {
      //   network: "arbitrum",
      //   chainId: 42161,
      //   urls: {
      //     apiURL: `https://api.arbiscan.io/api?apiKey=${arbitrumApiKey}`,
      //     browserURL: "https://arbiscan.io",
      //   },
      // },
    ],
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  typechain: {
    outDir: "src/types",
    target: "ethers-v6",
  },
};

export default config;
