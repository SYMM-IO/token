import { task, types } from "hardhat/config";

task("deploy:vestingV2", "Deploys the SymmVestingV2 logic and proxy using CREATE2")
	.addParam("admin", "The admin of the SymmVestingV2 contract")
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
	.setAction(async ({
						  admin,
						  penaltyreceiver,
						  pool,
						  router,
						  permit2,
						  vault,
						  symm,
						  usdc,
						  lp,
						  factory,
						  implsalt,
						  proxysalt,
					  }, { ethers }) => {
		console.log("Deploying deterministic contracts for SymmVestingV2...");
		const dryRun = false;

		// - Get an instance of your Create2Factory contract
		const create2Factory = await ethers.getContractAt("Create2Factory", factory);

		// - Get the contract factory for the logic contract
		const SymmVestingFactory = await ethers.getContractFactory("SymmVestingV2", {});

		// - Prepare implementation deployment bytecode
		const implDeployTx = await SymmVestingFactory.getDeployTransaction();
		const implBytecode = implDeployTx.data;
		if (!implBytecode) {
			throw new Error("Cannot obtain implementation deployment bytecode");
		}

		// - Compute a deterministic salt for implementation if not provided
		const implementationSalt = implsalt || ethers.keccak256(ethers.toUtf8Bytes(`vestingV2`));
		console.log("Implementation salt:", implementationSalt);

		// - Compute the predicted implementation address
		const predictedImplAddress = await create2Factory.getFunction("getAddress")(implBytecode, implementationSalt);
		console.log("Predicted implementation address:", predictedImplAddress);

		if (!dryRun) {
			// - Deploy the implementation via the factory using CREATE2
			console.log("Deploying implementation via CREATE2...");
			const implTx = await create2Factory.deploy(implBytecode, implementationSalt);
			await implTx.wait();
			console.log("Implementation deployed at:", predictedImplAddress);
			console.log();
		}

		// - Encode initializer data
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
		]);
		console.log("Deploying TransparentUpgradeableProxy with following params");
		console.log(predictedImplAddress, admin, initData);

		// - Get the TransparentUpgradeableProxy factory
		const TransparentUpgradeableProxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");

		// - Prepare proxy deployment bytecode
		// TransparentUpgradeableProxy constructor parameters: (logic, admin, data)
		const proxyDeployTx = await TransparentUpgradeableProxyFactory.getDeployTransaction(predictedImplAddress, admin, initData);
		const proxyBytecode = proxyDeployTx.data;
		if (!proxyBytecode) {
			throw new Error("Cannot obtain proxy deployment bytecode");
		}

		// - Compute a deterministic salt for proxy if not provided
		const proxySaltValue = proxysalt || ethers.keccak256(ethers.toUtf8Bytes(`proxy-vesting`));
		console.log("Proxy salt:", proxySaltValue);

		// console.log(proxyBytecode)

		// - Compute the predicted proxy address
		const predictedProxyAddress = await create2Factory.getFunction("getAddress")(proxyBytecode, proxySaltValue);
		console.log("Predicted proxy address:", predictedProxyAddress);

		if (!dryRun) {
			// - Deploy the proxy via the factory using CREATE2
			console.log("Deploying proxy via CREATE2...");
			const proxyTx = await create2Factory.deploy(proxyBytecode, proxySaltValue);
			await proxyTx.wait();
			console.log("CREATE2 deployment confirmed.");
			console.log("Deterministic TransparentUpgradeableProxy deployed at:", predictedProxyAddress);
		}

		return await ethers.getContractAt("SymmVestingV2", predictedProxyAddress);
	});
