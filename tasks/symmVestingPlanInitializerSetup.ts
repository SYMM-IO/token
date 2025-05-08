import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "hardhat";
import * as fs from "fs";

task("SymmVestingPlanInitializerSetup", "Setup the SymmVestingPlanInitializer contract")
	.addParam("deployedAddress", "Address initializer")
	.setAction(async ({ deployedAddress }, {
			ethers,
			upgrades,
		}: HardhatRuntimeEnvironment) => {
			console.log("Setup SymmVestingPlanInitializer");

			const signers = await ethers.getSigners();
			const admin = signers[0];

			const symmVestingPlanInitializer = await ethers.getContractAt("SymmVestingPlanInitializer", deployedAddress)

			const data = fs.readFileSync("user_available_symm.json", "utf8");
			const user_available: {
				Users: string[],
				Available: string[]
			} = JSON.parse(data);

			const chunkSize = 1000;
			const users = user_available.Users;
			const amounts = user_available.Available;

			fs.writeFileSync("error.log", "", { encoding: "utf-8" });
			for (let i = 0; i < users.length; i += chunkSize) {
				const usersChunk = users.slice(i, i + chunkSize);
				const amountsChunk = amounts.slice(i, i + chunkSize);
				try {
					await symmVestingPlanInitializer.connect(admin).setInitiatableVestingAmount(usersChunk, amountsChunk);
					console.log(`${i}..${i + chunkSize}: OK`);
				} catch (error) {
					console.error(`Error in users=${usersChunk}, amounts=${amountsChunk}`, error);
					const logMsg = `[Error in users=${JSON.stringify(usersChunk)}, amounts=${JSON.stringify(amountsChunk)}\n${(error as any).stack || error}\n\n`;

					fs.appendFileSync("error.log", logMsg, { encoding: "utf-8" });
				}
			}

			console.log(`Set successfully!`);
			return symmVestingPlanInitializer;
		},
	);
