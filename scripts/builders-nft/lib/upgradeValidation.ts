import fs from "node:fs"
import path from "node:path"

import { FunctionFragment, Interface, type InterfaceAbi } from "ethers"
import { getStorageUpgradeErrors, type StorageLayout } from "@openzeppelin/upgrades-core"

export type AbiFunction = {
	signature: string
	outputs: string[]
}

export type NftStorageBaseline = {
	schemaVersion: number
	contract: string
	runtimeCodeHash: string
	functions: AbiFunction[]
	storageLayout: StorageLayout
}

export function loadStorageBaseline(file: string): NftStorageBaseline {
	if (!fs.existsSync(file)) throw new Error(`Storage baseline does not exist: ${file}`)
	const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as NftStorageBaseline
	if (baseline.schemaVersion !== 1) throw new Error(`Unsupported storage baseline schemaVersion: ${baseline.schemaVersion}`)
	return baseline
}

export function findCompiledStorageLayout(contractFqn: string, buildInfoDirectory = path.resolve("artifacts/build-info")): StorageLayout {
	const [sourceName, contractName] = contractFqn.split(":")
	if (!sourceName || !contractName) throw new Error(`Invalid fully qualified contract name: ${contractFqn}`)
	if (!fs.existsSync(buildInfoDirectory)) throw new Error(`Build info directory does not exist: ${buildInfoDirectory}`)

	const files = fs
		.readdirSync(buildInfoDirectory)
		.filter(file => file.endsWith(".json"))
		.map(file => path.join(buildInfoDirectory, file))
		.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
	for (const file of files) {
		const buildInfo = JSON.parse(fs.readFileSync(file, "utf8")) as any
		const layout = buildInfo.output?.contracts?.[sourceName]?.[contractName]?.storageLayout
		if (layout) return layout as StorageLayout
	}
	throw new Error(`Storage layout not found for ${contractFqn}; run hardhat compile --force first`)
}

function abiFunctions(abi: InterfaceAbi): AbiFunction[] {
	const iface = new Interface(abi)
	return iface.fragments
		.filter((fragment): fragment is FunctionFragment => fragment.type === "function")
		.map(fragment => ({
			signature: fragment.format("sighash"),
			outputs: fragment.outputs.map(output => output.format("sighash")),
		}))
}

export function validateNftUpgrade(options: {
	baseline: NftStorageBaseline
	updatedLayout: StorageLayout
	updatedAbi: InterfaceAbi
	acceptedRemovedFunctions: string[]
}) {
	const storageErrors = getStorageUpgradeErrors(options.baseline.storageLayout, options.updatedLayout)
	const updated = new Map(abiFunctions(options.updatedAbi).map(item => [item.signature, item]))
	const accepted = new Set(options.acceptedRemovedFunctions)
	const removedFunctions = options.baseline.functions.filter(item => !updated.has(item.signature)).map(item => item.signature)
	const unacceptedRemovedFunctions = removedFunctions.filter(signature => !accepted.has(signature))
	const changedOutputs = options.baseline.functions
		.filter(item => updated.has(item.signature))
		.filter(item => JSON.stringify(item.outputs) !== JSON.stringify(updated.get(item.signature)?.outputs))
		.map(item => ({ signature: item.signature, before: item.outputs, after: updated.get(item.signature)?.outputs ?? [] }))
	return {
		storageCompatible: storageErrors.length === 0,
		storageErrors,
		removedFunctions,
		unacceptedRemovedFunctions,
		changedOutputs,
		ok: storageErrors.length === 0 && unacceptedRemovedFunctions.length === 0 && changedOutputs.length === 0,
	}
}
