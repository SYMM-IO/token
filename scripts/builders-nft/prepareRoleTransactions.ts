import { Contract, Interface, ZeroAddress, ZeroHash, getAddress, id } from "ethers"
import hre from "hardhat"

import { loadRolloutConfig } from "./lib/config.js"
import { prepareRolloutContext } from "./lib/execution.js"
import { readAccessControlMembers, requireCode, scanAccessControlMembers } from "./lib/onchain.js"
import { saveRoleTransactions, type PreparedTransaction, type RoleTransactionsFile } from "./lib/roleTransactions.js"

const accessControlInterface = new Interface([
	"function grantRole(bytes32 role,address account)",
	"function MINTER_ROLE() view returns (bytes32)",
	"function BURNER_ROLE() view returns (bytes32)",
	"function PAUSER_ROLE() view returns (bytes32)",
	"function UNPAUSER_ROLE() view returns (bytes32)",
])

const timelockInterface = new Interface([
	"function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
	"function execute(address target,uint256 value,bytes payload,bytes32 predecessor,bytes32 salt) payable",
])

async function main() {
	const { ethers } = await hre.network.create()
	const provider = ethers.provider
	const loaded = loadRolloutConfig()
	const { config } = loaded
	const state = await prepareRolloutContext(provider, loaded)
	if (!state.manager?.proxy) throw new Error(`Manager deployment is missing from ${loaded.stateFile}`)
	const manager = getAddress(state.manager.proxy)
	await requireCode(provider, "Manager proxy", manager)
	const managerContract = new Contract(
		manager,
		["function SYMM() view returns (address)", "function nftContract() view returns (address)"],
		provider,
	)
	if (getAddress(await managerContract.SYMM()) !== config.contracts.symm) throw new Error("Manager SYMM getter does not match config")
	if (getAddress(await managerContract.nftContract()) !== config.contracts.buildersNftProxy) {
		throw new Error("Manager nftContract getter does not match config")
	}

	const nft = new Contract(config.contracts.buildersNftProxy, accessControlInterface, provider)
	const symm = new Contract(config.contracts.symm, accessControlInterface, provider)
	const nftAdminMembers = await readAccessControlMembers(provider, config.contracts.buildersNftProxy, ZeroHash)
	const symmAdminMembers = await readAccessControlMembers(provider, config.contracts.symm, ZeroHash)
	if (!nftAdminMembers.includes(config.contracts.expectedBuildersNftProxyAdminOwner)) {
		throw new Error(`Expected NFT admin ${config.contracts.expectedBuildersNftProxyAdminOwner} is not a DEFAULT_ADMIN_ROLE member`)
	}
	if (!symmAdminMembers.includes(config.contracts.expectedSymmAdmin)) {
		throw new Error(`Expected SYMM admin ${config.contracts.expectedSymmAdmin} is not a DEFAULT_ADMIN_ROLE member`)
	}

	const nftRoleNames = ["MINTER_ROLE", "BURNER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"] as const
	const nftTransactions: PreparedTransaction[] = []
	for (const roleName of nftRoleNames) {
		const role = (await nft[roleName]()) as string
		nftTransactions.push({
			id: `nft-grant-${roleName.toLowerCase()}`,
			description: `Grant Builders NFT ${roleName} to the manager`,
			from: config.contracts.expectedBuildersNftProxyAdminOwner,
			to: config.contracts.buildersNftProxy,
			value: "0",
			data: accessControlInterface.encodeFunctionData("grantRole", [role, manager]),
		})
	}

	const symmMinterRole = (await symm.MINTER_ROLE()) as string
	const grantData = accessControlInterface.encodeFunctionData("grantRole", [symmMinterRole, manager])
	const timelock = new Contract(
		config.contracts.expectedSymmAdmin,
		[
			"function getMinDelay() view returns (uint256)",
			"function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)",
			"function PROPOSER_ROLE() view returns (bytes32)",
			"function EXECUTOR_ROLE() view returns (bytes32)",
		],
		provider,
	)
	const minimumDelay = (await timelock.getMinDelay()) as bigint
	const predecessor = config.roles.timelockPredecessor
	const salt = id(config.roles.timelockSaltLabel)
	const operationId = (await timelock.hashOperation(config.contracts.symm, 0n, grantData, predecessor, salt)) as string
	const proposerRole = (await timelock.PROPOSER_ROLE()) as string
	const executorRole = (await timelock.EXECUTOR_ROLE()) as string
	const proposerScan = await scanAccessControlMembers(
		provider,
		config.contracts.expectedSymmAdmin,
		proposerRole,
		config.roles.logScanChunkSize,
	)
	const executorScan = await scanAccessControlMembers(
		provider,
		config.contracts.expectedSymmAdmin,
		executorRole,
		config.roles.logScanChunkSize,
	)
	const proposers = proposerScan.members
	const executors = executorScan.members
	if (proposerScan.deploymentBlock !== executorScan.deploymentBlock) throw new Error("Timelock role scans disagree on deployment block")
	const openExecution = executors.includes(ZeroAddress)
	if (proposers.length === 0) throw new Error(`No active timelock proposers found from block ${proposerScan.deploymentBlock}`)
	if (executors.length === 0) throw new Error(`No active timelock executors found from block ${executorScan.deploymentBlock}`)

	const plan: RoleTransactionsFile = {
		schemaVersion: 1,
		chainId: config.network.chainId,
		networkName: config.network.name,
		generatedAt: new Date().toISOString(),
		manager,
		nftAdmin: {
			address: config.contracts.expectedBuildersNftProxyAdminOwner,
			transactions: nftTransactions,
		},
		symmTimelock: {
			address: config.contracts.expectedSymmAdmin,
			deploymentBlock: proposerScan.deploymentBlock,
			proposers,
			executors,
			openExecution,
			minimumDelay: minimumDelay.toString(),
			predecessor,
			salt,
			operationId,
			grantTransaction: {
				id: "symm-grant-minter",
				description: "Grant SYMM MINTER_ROLE to the manager; this is executed by the timelock",
				from: config.contracts.expectedSymmAdmin,
				to: config.contracts.symm,
				value: "0",
				data: grantData,
			},
			scheduleTransaction: {
				id: "timelock-schedule-symm-minter",
				description: "Schedule the SYMM MINTER_ROLE grant through the SYMM timelock",
				from: proposers.length === 1 ? proposers[0] : null,
				allowedCallers: proposers,
				to: config.contracts.expectedSymmAdmin,
				value: "0",
				data: timelockInterface.encodeFunctionData("schedule", [config.contracts.symm, 0n, grantData, predecessor, salt, minimumDelay]),
			},
			executeTransaction: {
				id: "timelock-execute-symm-minter",
				description: "Execute the SYMM MINTER_ROLE grant after the timelock delay",
				from: openExecution ? null : executors.length === 1 ? executors[0] : null,
				allowedCallers: openExecution ? [ZeroAddress] : executors,
				to: config.contracts.expectedSymmAdmin,
				value: "0",
				data: timelockInterface.encodeFunctionData("execute", [config.contracts.symm, 0n, grantData, predecessor, salt]),
			},
		},
	}
	saveRoleTransactions(loaded.roleTransactionsFile, plan)
	console.log(JSON.stringify(plan, null, 2))
	console.log(`Role transactions written to ${loaded.roleTransactionsFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
