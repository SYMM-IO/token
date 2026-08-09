import { Interface } from "ethers"

const abi: string[] = []
const iface = new Interface(abi)
const errorData = ""

try {
	const parsedError = iface.parseError(errorData)
	if (parsedError === null) throw new Error("Error data did not match the configured ABI")
	console.log("Error Name:", parsedError.name)
	console.log("Error Arguments:", parsedError.args)
} catch (error) {
	console.error("Error parsing the data:", error)
}
