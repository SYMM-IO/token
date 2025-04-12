import { task, types } from "hardhat/config"

task("deploy:staking", "Deploys the SymmStaking logic and proxy using CREATE2")
	.addParam("admin", "The admin of the SymmStaking contract")
	.addParam("token", "The address of the staking token")
	.addParam("factory", "The deployed Create2Factory contract address")
	.addParam("implsalt", "Salt for deploying the implementation contract", undefined, types.string, true)
	.addParam("proxysalt", "Salt for deploying the proxy contract", undefined, types.string, true)
	.setAction(async ({ admin, token, factory, implsalt, proxysalt }, { ethers }) => {
		console.log("Deploying deterministic contracts for SymmStaking...")
		const dryRun = false

		// 1. Get the contract factory for the logic contract
		const SymmStakingFactory = await ethers.getContractFactory("SymmStaking")

		// 2. Get an instance of your Create2Factory contract
		const create2Factory = await ethers.getContractAt("Create2Factory", factory)

		// 3. Prepare implementation deployment bytecode
		const implDeployTx = await SymmStakingFactory.getDeployTransaction()
		const implBytecode = implDeployTx.data
		if (!implBytecode) {
			throw new Error("Cannot obtain implementation deployment bytecode")
		}

		// 4. Compute a deterministic salt for implementation if not provided
		const implementationSalt = implsalt || ethers.keccak256(ethers.toUtf8Bytes(`staking`))
		console.log("Implementation salt:", implementationSalt)

		// 5. Compute the predicted implementation address
		// const predictedImplAddress = await create2Factory.getAddress(implBytecode, implementationSalt)
		// const predictedImplAddress = (await create2Factory.functions.getAddress(implBytecode, implementationSalt))[0];
		const predictedImplAddress = await create2Factory.getFunction("getAddress")(implBytecode, implementationSalt)
		console.log("Predicted implementation address:", predictedImplAddress)

		if (!dryRun) {
			// 6. Deploy the implementation via the factory using CREATE2
			console.log("Deploying implementation via CREATE2...")
			const implTx = await create2Factory.deploy(implBytecode, implementationSalt)
			await implTx.wait()
			console.log("Implementation deployed at:", predictedImplAddress)
		}

		console.log()

		// 7. Encode initializer data: initialize(admin, stakingToken)
		const initData = SymmStakingFactory.interface.encodeFunctionData("initialize", [admin, token])

		console.log("Deploying TransparentUpgradeableProxy with following params")
		console.log(predictedImplAddress, admin, initData)

		// 8. Get the TransparentUpgradeableProxy factory
		const TransparentUpgradeableProxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy")

		// 9. Prepare proxy deployment bytecode
		// TransparentUpgradeableProxy constructor parameters: (logic, admin, data)
		const proxyDeployTx = await TransparentUpgradeableProxyFactory.getDeployTransaction(predictedImplAddress, admin, initData)
		const proxyBytecode = proxyDeployTx.data
		if (!proxyBytecode) {
			throw new Error("Cannot obtain proxy deployment bytecode")
		}

		// 10. Compute a deterministic salt for proxy if not provided
		const proxySaltValue = proxysalt || ethers.keccak256(ethers.toUtf8Bytes(`proxy-staking`))
		console.log("Proxy salt:", proxySaltValue)

		// console.log(proxyBytecode)

		// 11. Compute the predicted proxy address
		const predictedProxyAddress = await create2Factory.getFunction("getAddress")(proxyBytecode, proxySaltValue)
		console.log("Predicted proxy address:", predictedProxyAddress)

		if (!dryRun) {
			// 12. Deploy the proxy via the factory using CREATE2
			console.log("Deploying proxy via CREATE2...")
			const proxyTx = await create2Factory.deploy(proxyBytecode, proxySaltValue)
			await proxyTx.wait()
			console.log("CREATE2 deployment confirmed.")
			console.log("Deterministic TransparentUpgradeableProxy deployed at:", predictedProxyAddress)
		}

		return {
			implementation: predictedImplAddress,
			proxy: predictedProxyAddress,
		}
	})
