import { task, types } from "hardhat/config"

task("deploy:vesting", "Deploys the SymmVesting logic and proxy using CREATE2")
	.addParam("admin", "The admin of the SymmVesting contract")
	.addParam("penaltyreceiver", "Address that receives the penalty")
	.addParam("pool", "Address of the pool")
	.addParam("router", "Address of the router")
	.addParam("permit2", "Address of the permit2")
	.addParam("vault", "Address of the vault")
	.addParam("symm", "Address of symm token")
	.addParam("usdc", "Address of usdc token")
	.addParam("lp", "Address of lp token")
	.addParam("factory", "The deployed Create2Factory contract address")
	.addParam("implsalt", "Salt for deploying the implementation contract", undefined, types.string, true)
	.addParam("proxysalt", "Salt for deploying the proxy contract", undefined, types.string, true)
	.setAction(async ({ admin, penaltyreceiver, pool, router, permit2, vault, symm, usdc, lp, factory, implsalt, proxysalt }, { ethers }) => {
		console.log("Deploying deterministic contracts for SymmVesting...")
		const dryRun = false

		// 1. Deploy the VestingPlanOps library first
		console.log("Deploying VestingPlanOps library...")
		const VestingPlanOpsFactory = await ethers.getContractFactory("VestingPlanOps")

		// 2. Get an instance of your Create2Factory contract
		const create2Factory = await ethers.getContractAt("Create2Factory", factory)

		// 3. Prepare library deployment bytecode
		const libDeployTx = await VestingPlanOpsFactory.getDeployTransaction()
		const libBytecode = libDeployTx.data
		if (!libBytecode) {
			throw new Error("Cannot obtain library deployment bytecode")
		}

		// 4. Compute a deterministic salt for library
		const librarySalt = ethers.keccak256(ethers.toUtf8Bytes(`library-vesting-planops`))
		console.log("Library salt:", librarySalt)

		// 5. Compute the predicted library address
		const predictedLibAddress = await create2Factory.getFunction("getAddress")(libBytecode, librarySalt)
		console.log("Predicted library address:", predictedLibAddress)

		if (!dryRun) {
			// 6. Deploy the library via the factory using CREATE2
			console.log("Deploying library via CREATE2...")
			const libTx = await create2Factory.deploy(libBytecode, librarySalt)
			await libTx.wait()
			console.log("Library deployed at:", predictedLibAddress)
		}

		console.log()

		// 7. Get the contract factory for the logic contract with library linkage
		const SymmVestingFactory = await ethers.getContractFactory("SymmVesting", {
			libraries: {
				VestingPlanOps: predictedLibAddress,
			},
		})

		// 8. Prepare implementation deployment bytecode
		const implDeployTx = await SymmVestingFactory.getDeployTransaction()
		const implBytecode = implDeployTx.data
		if (!implBytecode) {
			throw new Error("Cannot obtain implementation deployment bytecode")
		}

		// 9. Compute a deterministic salt for implementation if not provided
		const implementationSalt = implsalt || ethers.keccak256(ethers.toUtf8Bytes(`vesting`))
		console.log("Implementation salt:", implementationSalt)

		// 10. Compute the predicted implementation address
		const predictedImplAddress = await create2Factory.getFunction("getAddress")(implBytecode, implementationSalt)
		console.log("Predicted implementation address:", predictedImplAddress)

		if (!dryRun) {
			// 11. Deploy the implementation via the factory using CREATE2
			console.log("Deploying implementation via CREATE2...")
			const implTx = await create2Factory.deploy(implBytecode, implementationSalt)
			await implTx.wait()
			console.log("Implementation deployed at:", predictedImplAddress)
			console.log()
		}

		// 12. Encode initializer data
		const initData = SymmVestingFactory.interface.encodeFunctionData("initialize", [
			admin,
			penaltyreceiver,
			pool,
			router,
			permit2,
			vault,
			symm,
			usdc,
			lp,
		])
		console.log("Deploying TransparentUpgradeableProxy with following params")
		console.log(predictedImplAddress, admin, initData)

		// 13. Get the TransparentUpgradeableProxy factory
		const TransparentUpgradeableProxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy")

		// 14. Prepare proxy deployment bytecode
		// TransparentUpgradeableProxy constructor parameters: (logic, admin, data)
		const proxyDeployTx = await TransparentUpgradeableProxyFactory.getDeployTransaction(predictedImplAddress, admin, initData)
		const proxyBytecode = proxyDeployTx.data
		if (!proxyBytecode) {
			throw new Error("Cannot obtain proxy deployment bytecode")
		}

		// 15. Compute a deterministic salt for proxy if not provided
		const proxySaltValue = proxysalt || ethers.keccak256(ethers.toUtf8Bytes(`proxy-vesting`))
		console.log("Proxy salt:", proxySaltValue)

		// console.log(proxyBytecode)

		// 16. Compute the predicted proxy address
		const predictedProxyAddress = await create2Factory.getFunction("getAddress")(proxyBytecode, proxySaltValue)
		console.log("Predicted proxy address:", predictedProxyAddress)

		if (!dryRun) {
			// 17. Deploy the proxy via the factory using CREATE2
			console.log("Deploying proxy via CREATE2...")
			const proxyTx = await create2Factory.deploy(proxyBytecode, proxySaltValue)
			await proxyTx.wait()
			console.log("CREATE2 deployment confirmed.")
			console.log("Deterministic TransparentUpgradeableProxy deployed at:", predictedProxyAddress)
		}

		return {
			library: predictedLibAddress,
			implementation: predictedImplAddress,
			proxy: predictedProxyAddress,
		}
	})
