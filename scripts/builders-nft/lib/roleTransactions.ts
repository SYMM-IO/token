import fs from "node:fs"
import path from "node:path"

export type PreparedTransaction = {
	id: string
	description: string
	from: string | null
	allowedCallers?: string[]
	to: string
	value: string
	data: string
}

export type RoleTransactionsFile = {
	schemaVersion: 1
	chainId: number
	networkName: string
	generatedAt: string
	manager: string
	nftAdmin: {
		address: string
		transactions: PreparedTransaction[]
	}
	symmTimelock: {
		address: string
		deploymentBlock: number
		proposers: string[]
		executors: string[]
		openExecution: boolean
		minimumDelay: string
		predecessor: string
		salt: string
		operationId: string
		grantTransaction: PreparedTransaction
		scheduleTransaction: PreparedTransaction
		executeTransaction: PreparedTransaction
	}
}

export function saveRoleTransactions(file: string, plan: RoleTransactionsFile): void {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporaryFile = `${file}.${process.pid}.tmp`
	fs.writeFileSync(temporaryFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8")
	fs.renameSync(temporaryFile, file)
}

export function loadRoleTransactions(file: string): RoleTransactionsFile {
	if (!fs.existsSync(file)) throw new Error(`Role transaction JSON does not exist: ${file}`)
	const plan = JSON.parse(fs.readFileSync(file, "utf8")) as RoleTransactionsFile
	if (plan.schemaVersion !== 1) throw new Error(`Unsupported role transaction schemaVersion: ${plan.schemaVersion}`)
	return plan
}
