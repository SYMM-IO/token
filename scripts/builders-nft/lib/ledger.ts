import {
	AbstractSigner,
	Signature,
	Transaction,
	copyRequest,
	getAddress,
	resolveAddress,
	resolveProperties,
	type Provider,
	type Signer,
	type TransactionLike,
	type TransactionRequest,
	type TransactionResponse,
	type TypedDataDomain,
	type TypedDataField,
} from "ethers"
import { createRequire } from "node:module"
import path from "node:path"

import type { LedgerScanConfig } from "./config"
import { saveRolloutState, type LedgerDiscovery, type RolloutState } from "./state"

type LedgerApp = {
	getAddress(path: string, display: boolean): Promise<{ address: string }>
	signTransaction(path: string, unsignedTransaction: string, resolution: null): Promise<{ r: string; s: string; v: string | number }>
}

export type LedgerCandidate = {
	id: number
	path: string
	scheme: string
	accountIndex?: number
	addressIndex?: number
}

const requireFromProject = createRequire(path.resolve(process.cwd(), "package.json"))

function addCandidate(candidates: LedgerCandidate[], candidate: Omit<LedgerCandidate, "id">): void {
	if (candidates.some(item => item.path === candidate.path)) return
	candidates.push({ id: candidates.length, ...candidate })
}

export function buildLedgerCandidates(scan: LedgerScanConfig): LedgerCandidate[] {
	const candidates: LedgerCandidate[] = []
	for (const ledgerPath of scan.extraPaths) addCandidate(candidates, { path: ledgerPath, scheme: "configured" })
	for (let accountIndex = 0; accountIndex < scan.accountCount; accountIndex++) {
		addCandidate(candidates, { path: `m/44'/60'/${accountIndex}'/0/0`, scheme: "ledger-live", accountIndex })
	}
	for (let addressIndex = 0; addressIndex < scan.addressCount; addressIndex++) {
		addCandidate(candidates, { path: `m/44'/60'/0'/0/${addressIndex}`, scheme: "ledger-live-address", addressIndex })
	}
	for (let addressIndex = 0; addressIndex < scan.addressCount; addressIndex++) {
		addCandidate(candidates, { path: `m/44'/60'/0'/${addressIndex}`, scheme: "legacy-ledger", addressIndex })
	}
	return candidates
}

export async function scanLedgerApp(app: LedgerApp, expectedAddress: string, scan: LedgerScanConfig): Promise<LedgerDiscovery> {
	const expected = getAddress(expectedAddress)
	for (const candidate of buildLedgerCandidates(scan)) {
		const result = await app.getAddress(candidate.path, false)
		const address = getAddress(result.address)
		console.log(`[ledger] candidate ${candidate.id}: ${address} ${candidate.path}`)
		if (address !== expected) continue
		return {
			expectedAddress: expected,
			address,
			path: candidate.path,
			candidateId: candidate.id,
			scheme: candidate.scheme,
			accountIndex: candidate.accountIndex,
			addressIndex: candidate.addressIndex,
			discoveredAt: new Date().toISOString(),
		}
	}
	throw new Error(`Ledger address ${expected} was not found in ${buildLedgerCandidates(scan).length} configured candidates`)
}

async function openLedgerApp(): Promise<LedgerApp> {
	try {
		let transportModule: any
		try {
			transportModule = requireFromProject("@ledgerhq/hw-transport-node-hid-noevents")
		} catch {
			transportModule = requireFromProject("@ledgerhq/hw-transport-node-hid")
		}
		const ethModule = requireFromProject("@ledgerhq/hw-app-eth")
		const Transport = transportModule.default ?? transportModule
		const Eth = ethModule.default ?? ethModule
		const transport = typeof Transport.open === "function" ? await Transport.open(undefined) : await Transport.create()
		return new Eth(transport) as LedgerApp
	} catch (error) {
		throw new Error(
			"Ledger packages are optional. Install them without changing the lockfile using: " +
				"npm install --no-save --package-lock=false @ledgerhq/hw-transport-node-hid-noevents @ledgerhq/hw-app-eth. " +
				`Original error: ${(error as Error).message}`,
		)
	}
}

function ledgerV(value: string | number): bigint | number {
	if (typeof value === "number") return value
	const parsed = BigInt(value.startsWith("0x") ? value : `0x${value}`)
	return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed
}

class LedgerSigner extends AbstractSigner<Provider> {
	constructor(
		private readonly ledgerPath: string,
		private readonly expectedAddress: string,
		provider: Provider,
		private readonly app: LedgerApp,
	) {
		super(provider)
	}

	connect(provider: null | Provider): Signer {
		if (!provider) throw new Error("Ledger signer requires a provider")
		return new LedgerSigner(this.ledgerPath, this.expectedAddress, provider, this.app)
	}

	async getAddress(): Promise<string> {
		return this.expectedAddress
	}

	async signTransaction(tx: TransactionRequest): Promise<string> {
		const request = copyRequest(tx)
		const resolved = await resolveProperties({
			to: request.to ? resolveAddress(request.to, this) : undefined,
			from: request.from ? resolveAddress(request.from, this) : undefined,
		})
		if (resolved.to != null) request.to = resolved.to
		if (resolved.from != null && getAddress(String(resolved.from)) !== this.expectedAddress) {
			throw new Error(`Transaction sender ${resolved.from} does not match Ledger ${this.expectedAddress}`)
		}
		delete request.from
		const transaction = Transaction.from(request as TransactionLike<string>)
		console.log(
			JSON.stringify(
				{
					ledgerPath: this.ledgerPath,
					from: this.expectedAddress,
					to: transaction.to,
					chainId: transaction.chainId.toString(),
					nonce: transaction.nonce,
					value: transaction.value.toString(),
					gasLimit: transaction.gasLimit.toString(),
					data: transaction.data,
					unsignedHash: transaction.unsignedHash,
				},
				null,
				2,
			),
		)
		const verified = getAddress((await this.app.getAddress(this.ledgerPath, false)).address)
		if (verified !== this.expectedAddress) throw new Error(`Ledger path changed from ${this.expectedAddress} to ${verified}`)
		const signature = await this.app.signTransaction(this.ledgerPath, transaction.unsignedSerialized.slice(2), null)
		transaction.signature = Signature.from({
			r: signature.r.startsWith("0x") ? signature.r : `0x${signature.r}`,
			s: signature.s.startsWith("0x") ? signature.s : `0x${signature.s}`,
			v: ledgerV(signature.v),
		})
		return transaction.serialized
	}

	async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
		const response = await super.sendTransaction(tx)
		console.log(`[ledger] submitted ${response.hash}`)
		return response
	}

	async signMessage(): Promise<string> {
		throw new Error("Message signing is not required by the Builders NFT rollout")
	}

	async signTypedData(_domain: TypedDataDomain, _types: Record<string, Array<TypedDataField>>, _value: Record<string, any>): Promise<string> {
		throw new Error("Typed-data signing is not required by the Builders NFT rollout")
	}
}

export async function resolveLedgerSigner(options: {
	role: string
	expectedAddress: string
	provider: Provider
	scan: LedgerScanConfig
	state: RolloutState
	stateFile: string
}): Promise<Signer> {
	const expectedAddress = getAddress(options.expectedAddress)
	const app = await openLedgerApp()
	let discovery = options.state.ledger?.[options.role]
	if (discovery) {
		if (getAddress(discovery.expectedAddress) !== expectedAddress) {
			throw new Error(`Saved Ledger ${options.role} address ${discovery.expectedAddress} does not match ${expectedAddress}`)
		}
		const actual = getAddress((await app.getAddress(discovery.path, false)).address)
		if (actual !== expectedAddress) throw new Error(`Saved Ledger path ${discovery.path} returned ${actual}, expected ${expectedAddress}`)
		console.log(`[ledger] reused ${options.role} candidate ${discovery.candidateId}: ${discovery.path}`)
	} else {
		discovery = await scanLedgerApp(app, expectedAddress, options.scan)
		options.state.ledger ??= {}
		options.state.ledger[options.role] = discovery
		saveRolloutState(options.stateFile, options.state)
		console.log(`[ledger] saved ${options.role} candidate ${discovery.candidateId} to ${options.stateFile}`)
	}
	return new LedgerSigner(discovery.path, expectedAddress, options.provider, app)
}
