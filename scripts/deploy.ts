import hre from "hardhat"

async function main() {
	const { ethers } = await hre.network.create()
	const contractName = ""
	const factory = await ethers.getContractFactory(contractName)
	const contract = await factory.deploy()

	await contract.waitForDeployment()

	console.log(`${contractName} deployed: ${await contract.getAddress()}`)

	await hre.tasks.getTask("verify").run({
		address: await contract.getAddress(),
		constructorArgs: [],
	})
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
