import { task } from "hardhat/config"

const deploySymmioToken = task("deploy:SymmioToken", "Deploys the Symmio token")
	.addOption({ name: "name", description: "The name of the Symmio token contract", defaultValue: "" })
	.addOption({ name: "symbol", description: "The symbol of the Symmio token contract", defaultValue: "" })
	.addOption({ name: "admin", description: "The admin address of the Symmio token contract", defaultValue: "" })
	.setAction(() => import("./symmioToken.js"))
	.build()

const deploySymmAllocationClaimer = task("deploy:SymmAllocationClaimer", "Deploys the SymmAllocationClaimer")
	.addOption({ name: "admin", description: "The admin address of the SymmAllocationClaimer contract", defaultValue: "" })
	.addOption({ name: "setter", description: "The setter address of the SymmAllocationClaimer contract", defaultValue: "" })
	.addOption({ name: "token", description: "The address of the SYMM token", defaultValue: "" })
	.addOption({ name: "symmioFoundation", description: "The address of the Symmio Foundation", defaultValue: "" })
	.addOption({ name: "mintFactor", description: "The mint factor", defaultValue: "" })
	.setAction(() => import("./symmAllocationClaimer.js"))
	.build()

const deploySymmStaking = task("deploy:SymmStaking", "Deploys the SymmStaking logic and proxy using CREATE2")
	.addOption({ name: "admin", description: "The admin of the SymmStaking contract", defaultValue: "" })
	.addOption({ name: "token", description: "The address of the staking token", defaultValue: "" })
	.addOption({ name: "factory", description: "The deployed Create2Factory contract address", defaultValue: "" })
	.addOption({ name: "implsalt", description: "Optional salt for the implementation contract", defaultValue: "" })
	.addOption({ name: "proxysalt", description: "Optional salt for the proxy contract", defaultValue: "" })
	.setAction(() => import("./symmStaking.js"))
	.build()

const deploySymmVesting = task("deploy:vesting", "Deploys the SymmVesting logic and proxy using CREATE2")
	.addOption({ name: "admin", description: "The admin of the SymmVesting contract", defaultValue: "" })
	.addOption({ name: "penaltyreceiver", description: "Address that receives the penalty", defaultValue: "" })
	.addOption({ name: "pool", description: "Address of the pool", defaultValue: "" })
	.addOption({ name: "router", description: "Address of the router", defaultValue: "" })
	.addOption({ name: "permit2", description: "Address of Permit2", defaultValue: "" })
	.addOption({ name: "vault", description: "Address of the vault", defaultValue: "" })
	.addOption({ name: "symm", description: "Address of the SYMM token", defaultValue: "" })
	.addOption({ name: "usdc", description: "Address of the USDC token", defaultValue: "" })
	.addOption({ name: "lp", description: "Address of the LP token", defaultValue: "" })
	.addOption({ name: "factory", description: "The deployed Create2Factory contract address", defaultValue: "" })
	.addOption({ name: "implsalt", description: "Optional salt for the implementation contract", defaultValue: "" })
	.addOption({ name: "proxysalt", description: "Optional salt for the proxy contract", defaultValue: "" })
	.setAction(() => import("./symmVesting.js"))
	.build()

const deploySymmVestingV2 = task("deploy:vestingV2", "Deploys the SymmVestingV2 logic and proxy using CREATE2")
	.addOption({ name: "admin", description: "The admin of the SymmVestingV2 contract", defaultValue: "" })
	.addOption({ name: "penaltyreceiver", description: "Address that receives the penalty", defaultValue: "" })
	.addOption({ name: "pool", description: "Address of the pool", defaultValue: "" })
	.addOption({ name: "router", description: "Address of the router", defaultValue: "" })
	.addOption({ name: "permit2", description: "Address of Permit2", defaultValue: "" })
	.addOption({ name: "vault", description: "Address of the vault", defaultValue: "" })
	.addOption({ name: "symm", description: "Address of the SYMM token", defaultValue: "" })
	.addOption({ name: "usdc", description: "Address of the USDC token", defaultValue: "" })
	.addOption({ name: "lp", description: "Address of the LP token", defaultValue: "" })
	.addOption({ name: "factory", description: "The deployed Create2Factory contract address", defaultValue: "" })
	.addOption({ name: "implsalt", description: "Optional salt for the implementation contract", defaultValue: "" })
	.addOption({ name: "proxysalt", description: "Optional salt for the proxy contract", defaultValue: "" })
	.setAction(() => import("./symmVestingV2.js"))
	.build()

const deploySymmVestingPlanInitializer = task(
	"deploy:SymmVestingPlanInitializer",
	"Deploys the SymmVestingPlanInitializer contract",
)
	.addOption({ name: "symmTokenAddress", description: "Address of the SYMM token", defaultValue: "" })
	.addOption({ name: "symmVestingAddress", description: "Address of the SymmVesting contract", defaultValue: "" })
	.addOption({ name: "totalInitiatableSYMM", description: "Total initiatable SYMM", defaultValue: "" })
	.addOption({ name: "launchTimeStamp", description: "Launch timestamp in seconds", defaultValue: "" })
	.setAction(() => import("./symmVestingPlanInitializer.js"))
	.build()

const setupSymmVestingPlanInitializer = task(
	"SymmVestingPlanInitializerSetup",
	"Sets up the SymmVestingPlanInitializer contract",
)
	.addOption({ name: "deployedAddress", description: "Address of the initializer", defaultValue: "" })
	.setAction(() => import("./symmVestingPlanInitializerSetup.js"))
	.build()

const deploySymmioBuildersNft = task("deploy:SymmioBuildersNft", "Deploys the SymmioBuildersNft contract")
	.addOption({ name: "admin", description: "Address receiving the NFT admin and pause roles", defaultValue: "" })
	.setAction(() => import("./symmioBuildersNft.js"))
	.build()

const deploySymmioBuildersNftManager = task(
	"deploy:SymmioBuildersNftManager",
	"Deploys the SymmioBuildersNftManager contract",
)
	.addOption({ name: "symm", description: "SYMM token address", defaultValue: "" })
	.addOption({ name: "nft", description: "SymmioBuildersNft proxy address", defaultValue: "" })
	.addOption({ name: "admin", description: "Address receiving all manager administration roles", defaultValue: "" })
	.addOption({ name: "minlockamount", description: "Minimum SYMM amount required to mint an NFT, in wei", defaultValue: "" })
	.addOption({ name: "cliffduration", description: "Unlock cliff duration, in seconds", defaultValue: "" })
	.addOption({ name: "vestingduration", description: "Linear vesting duration, in seconds", defaultValue: "" })
	.addOption({ name: "penaltyrate", description: "Early-claim penalty scaled by 1e18", defaultValue: "" })
	.addOption({ name: "penaltyreceiver", description: "Address receiving early-claim penalties", defaultValue: "" })
	.addOption({ name: "proxyadminowner", description: "Optional owner of the manager proxy's dedicated ProxyAdmin", defaultValue: "" })
	.addFlag({ name: "grantroles", description: "Grant the manager its required SYMM and NFT roles from the deployer" })
	.setAction(() => import("./symmioBuildersNftManager.js"))
	.build()

export const tasks = [
	deploySymmioToken,
	deploySymmAllocationClaimer,
	deploySymmStaking,
	deploySymmVesting,
	deploySymmVestingV2,
	deploySymmVestingPlanInitializer,
	setupSymmVestingPlanInitializer,
	deploySymmioBuildersNft,
	deploySymmioBuildersNftManager,
]
