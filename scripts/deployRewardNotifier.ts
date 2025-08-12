import { ethers, run } from "hardhat"

async function main() {
	const symmAddress = "0x800822d361335b4d5F352Dac293cA4128b5B605f"
	const admin = "0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9"
	const stakingAddress = "0x573310A15f3dc4828994819bc67AB6B1596AC90c"

	const [deployer] = await ethers.getSigners()

	console.log("Deploying contracts with the account:", deployer.address)

	// Deploy MultiAccount as upgradeable
	const Factory = await ethers.getContractFactory("RewardNotifier")
	const contract = await Factory.deploy(admin, symmAddress, stakingAddress)
	await contract.waitForDeployment()

	const deployedAddress = await contract.getAddress()
	console.log("RewardNotifier deployed to", deployedAddress)

	await new Promise(resolve => setTimeout(resolve, 15000))

	try {
		console.log(`Verifying ${deployedAddress}`)
		await run("verify:verify", {
			address: deployedAddress,
			constructorArguments: [admin, symmAddress, stakingAddress],
		})
	} catch (err) {
		console.error(err)
	}
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error)
		process.exit(1)
	})
