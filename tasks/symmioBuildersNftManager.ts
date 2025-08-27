import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers, upgrades } from "hardhat";

task("deploy:SymmioBuildersNftManager", "Deploys the SymmioBuildersNftManager contract")
	.addParam("symm", "address of symmToken")
	.addParam("nft", "address of symmioBuildersNft")
	.setAction(async ({ symm, nft }, {
			ethers,
			upgrades,
		}: HardhatRuntimeEnvironment) => {
			console.log("deploy:SymmioBuildersNftManager");

			const signers = await ethers.getSigners();

			const admin = signers[0];
			const minLockAmount = BigInt(100000000000000000000);
			const cliffDuration = 10;
			const vestingDuration = 3600;
			const lockedClaimPenalty = 20;
			const lockedClaimPenaltyReceiver = "0xBcd4042DE499D14e55001CcbB24a551F3b954096";

			const symmioBuildersNftManager = await ethers.getContractFactory("SymmioBuildersNftManager");

			const contract = await upgrades.deployProxy(
				symmioBuildersNftManager,
				[
					symm,
					nft,
					admin.address,
					minLockAmount,
					cliffDuration,
					vestingDuration,
					lockedClaimPenalty,
					lockedClaimPenaltyReceiver,
				],
				{ initializer: "initialize" });
			await contract.waitForDeployment();

			const implDeployTx = await symmioBuildersNftManager.getDeployTransaction();
			const implBytecode = implDeployTx.data;
			if (!implBytecode) {
				throw new Error("Cannot obtain implementation deployment bytecode");
			}

			console.log(`symmioBuildersNftManager Contract deployed at ${await contract.getAddress()}`);
			return contract;
		},
	);
