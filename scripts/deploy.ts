import { ethers, run } from "hardhat";

// async function main() {
//   const contractName = "Symmio";
//   const Contract = await ethers.getContractFactory(contractName);
//   const contract = await Contract.deploy("Symmio", "SYMM", "0x39E4cdd23Ef0994D38da526da0D2CDfb5b1624f3");

//   await contract.waitForDeployment();

//   console.log(`${contractName} deployed: ${await contract.getAddress()}`);
//   await run("verify:verify", {
//     address: await contract.getAddress(),
//     constructorArguments: ["Symmio", "SYMM", "0x39E4cdd23Ef0994D38da526da0D2CDfb5b1624f3"],
//   });
// }
async function main() {
  const contractName = "Create2Factory";
  const Contract = await ethers.getContractFactory(contractName);
  const contract = await Contract.deploy("0x39E4cdd23Ef0994D38da526da0D2CDfb5b1624f3", "0x9BC9CA7e6A8F013f40617c4585508A988DB7C1c7");

  await contract.waitForDeployment();

  console.log(`${contractName} deployed: ${await contract.getAddress()}`);
//   await run("verify:verify", {
//     address: await contract.getAddress(),
//     constructorArguments: ["0x39E4cdd23Ef0994D38da526da0D2CDfb5b1624f3", "0x9BC9CA7e6A8F013f40617c4585508A988DB7C1c7"],
//   });
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
