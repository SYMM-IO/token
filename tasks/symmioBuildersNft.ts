import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers, upgrades } from "hardhat";

task("deploy:SymmioBuildersNft", "Deploys the SymmioBuildersNft contract")
	.setAction(async ({}, {
			ethers,
			upgrades,
		}: HardhatRuntimeEnvironment) => {
			console.log("deploy:SymmioBuildersNft");

			const signers = await ethers.getSigners();
			const admin = signers[0];

			const symmioBuildersNft = await ethers.getContractFactory("SymmioBuildersNft");

			const contract = await upgrades.deployProxy(symmioBuildersNft, [admin.address], { initializer: "initialize" });
			await contract.waitForDeployment();

			const implDeployTx = await symmioBuildersNft.getDeployTransaction();
			const implBytecode = implDeployTx.data;
			if (!implBytecode) {
				throw new Error("Cannot obtain implementation deployment bytecode");
			}

			console.log(`symmioBuildersNft Contract deployed at ${await contract.getAddress()}`);
			return contract;
		},
	);
