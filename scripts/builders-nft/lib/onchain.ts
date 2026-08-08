import { Contract, Interface, ZeroHash, getAddress, id, keccak256, toBeHex, toUtf8Bytes, type Provider } from "ethers"

import type { NftSnapshot } from "./state"

function eip1967Slot(label: string): string {
	return toBeHex(BigInt(keccak256(toUtf8Bytes(label))) - 1n, 32)
}

const IMPLEMENTATION_SLOT = eip1967Slot("eip1967.proxy.implementation")
const ADMIN_SLOT = eip1967Slot("eip1967.proxy.admin")

export async function readSlotAddress(provider: Provider, address: string, slot: string): Promise<string> {
	const value = await provider.getStorage(address, slot)
	return getAddress(`0x${value.slice(-40)}`)
}

export async function readProxyImplementation(provider: Provider, proxy: string): Promise<string> {
	return readSlotAddress(provider, proxy, IMPLEMENTATION_SLOT)
}

export async function readProxyAdmin(provider: Provider, proxy: string): Promise<string> {
	return readSlotAddress(provider, proxy, ADMIN_SLOT)
}

export async function readOwnableOwner(provider: Provider, contractAddress: string): Promise<string> {
	const contract = new Contract(contractAddress, ["function owner() view returns (address)"], provider)
	return getAddress(await contract.owner())
}

export async function requireCode(provider: Provider, label: string, address: string): Promise<string> {
	const code = await provider.getCode(address)
	if (code === "0x") throw new Error(`${label} has no code at ${address}`)
	return code
}

export async function runtimeCodeHash(provider: Provider, address: string): Promise<string> {
	return keccak256(await requireCode(provider, "Contract", address))
}

export async function readAccessControlMembers(provider: Provider, address: string, role: string): Promise<string[]> {
	const contract = new Contract(
		address,
		["function getRoleMemberCount(bytes32) view returns (uint256)", "function getRoleMember(bytes32,uint256) view returns (address)"],
		provider,
	)
	const count = (await contract.getRoleMemberCount(role)) as bigint
	const members: string[] = []
	for (let index = 0n; index < count; index++) members.push(getAddress(await contract.getRoleMember(role, index)))
	return members
}

export async function findContractDeploymentBlock(provider: Provider, address: string): Promise<number> {
	const latestBlock = await provider.getBlockNumber()
	if ((await provider.getCode(address, latestBlock)) === "0x") throw new Error(`Contract has no code at ${address}`)
	let low = 0
	let high = latestBlock
	while (low < high) {
		const middle = Math.floor((low + high) / 2)
		if ((await provider.getCode(address, middle)) === "0x") low = middle + 1
		else high = middle
	}
	return low
}

export async function scanAccessControlMembers(
	provider: Provider,
	address: string,
	role: string,
	chunkSize: number,
): Promise<{ deploymentBlock: number; members: string[] }> {
	const iface = new Interface([
		"event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
		"event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)",
	])
	const deploymentBlock = await findContractDeploymentBlock(provider, address)
	const latestBlock = await provider.getBlockNumber()
	const grantedTopic = iface.getEvent("RoleGranted")!.topicHash
	const revokedTopic = iface.getEvent("RoleRevoked")!.topicHash
	const members = new Set<string>()
	for (let fromBlock = deploymentBlock; fromBlock <= latestBlock; fromBlock += chunkSize) {
		const toBlock = Math.min(fromBlock + chunkSize - 1, latestBlock)
		const logs = await provider.getLogs({
			address,
			fromBlock,
			toBlock,
			topics: [[grantedTopic, revokedTopic], role],
		})
		for (const log of logs) {
			const parsed = iface.parseLog(log)
			if (!parsed) continue
			const account = getAddress(parsed.args.account)
			if (parsed.name === "RoleGranted") members.add(account)
			else members.delete(account)
		}
	}
	const accessControl = new Contract(address, ["function hasRole(bytes32,address) view returns (bool)"], provider)
	const verified: string[] = []
	for (const member of members) if (await accessControl.hasRole(role, member)) verified.push(member)
	return { deploymentBlock, members: verified }
}

export async function snapshotNft(provider: Provider, address: string): Promise<NftSnapshot> {
	const nft = new Contract(
		address,
		[
			"function totalSupply() view returns (uint256)",
			"function tokenByIndex(uint256) view returns (uint256)",
			"function ownerOf(uint256) view returns (address)",
			"function getLockData(uint256) view returns (tuple(uint256 amount,uint256 lockTimestamp,uint256 unlockingAmount,string name))",
			"function paused() view returns (bool)",
			"function transfersPaused() view returns (bool)",
			"function getRoleMemberCount(bytes32) view returns (uint256)",
			"function getRoleMember(bytes32,uint256) view returns (address)",
		],
		provider,
	)
	const totalSupply = (await nft.totalSupply()) as bigint
	const tokens: NftSnapshot["tokens"] = []
	for (let index = 0n; index < totalSupply; index++) {
		const tokenId = (await nft.tokenByIndex(index)) as bigint
		const data = await nft.getLockData(tokenId)
		tokens.push({
			tokenId: tokenId.toString(),
			owner: getAddress(await nft.ownerOf(tokenId)),
			amount: data.amount.toString(),
			lockTimestamp: data.lockTimestamp.toString(),
			unlockingAmount: data.unlockingAmount.toString(),
			name: data.name,
		})
	}
	const roles: Record<string, string[]> = {}
	for (const roleName of ["DEFAULT_ADMIN_ROLE", "MINTER_ROLE", "BURNER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE"]) {
		const role = roleName === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(roleName)
		const count = (await nft.getRoleMemberCount(role)) as bigint
		roles[roleName] = []
		for (let index = 0n; index < count; index++) roles[roleName].push(getAddress(await nft.getRoleMember(role, index)))
	}
	return {
		totalSupply: totalSupply.toString(),
		paused: await nft.paused(),
		transfersPaused: await nft.transfersPaused(),
		tokens,
		roles,
	}
}
