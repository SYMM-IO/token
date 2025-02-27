import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { ethers, run } from "hardhat"
import { e } from "../utils"
import { SymmAllocationClaimer, Symmio, Vesting, SymmStaking } from "../typechain-types";


export class RunContext {
	signers!: {
		admin: SignerWithAddress
		setter: SignerWithAddress
		user1: SignerWithAddress
		user2: SignerWithAddress
		symmioFoundation: SignerWithAddress
		vestingPenaltyReceiver: SignerWithAddress
	}
	symmioToken!: Symmio
	claimSymm!: SymmAllocationClaimer
	vesting!: Vesting
	symmStaking !: SymmStaking

}

export async function initializeFixture(): Promise<RunContext> {
	let context = new RunContext()
	const signers: SignerWithAddress[] = await ethers.getSigners()
	context.signers = {
		admin: signers[0],
		setter: signers[1],
		user1: signers[2],
		user2: signers[3],
		symmioFoundation: signers[4],
		vestingPenaltyReceiver: signers[5],
	}

	context.symmioToken = await run("deploy:SymmioToken", {
		name: "SYMMIO",
		symbol: "SYMM",
		admin: await context.signers.admin.getAddress(),
	})

	context.claimSymm = await run("deploy:SymmAllocationClaimer", {
		admin: await context.signers.admin.getAddress(),
		setter: await context.signers.setter.getAddress(),
		token: await context.symmioToken.getAddress(),
		symmioFoundation: await context.signers.symmioFoundation.getAddress(),
		mintFactor: "500000000000000000", //5e17 => %50
	})


	context.vesting = await run("deploy:Vesting", {
		admin: await context.signers.admin.getAddress(),
		lockedClaimPenaltyReceiver: await context.signers.vestingPenaltyReceiver.getAddress(),

	// context.vesting = await run("deploy:Vesting", {
	// 	admin: context.signers.admin.getAddress(),
	// 	totalTime: "23328000", //9 months: 9*30*24*60*60
	// 	startTime: Math.floor(Date.now() / 1000) - 5184000, //two months: 2*30*24*60*60,
	// 	symmAddress: context.symmioToken.getAddress()
	// })

	context.symmStaking = await run("deploy:SymmStaking", {
		admin: await context.signers.admin.getAddress(),
		stakingToken: await context.symmioToken.getAddress()
	})

	await context.symmioToken.grantRole(await context.symmioToken.MINTER_ROLE(), context.signers.admin)

	const roles = [
		await context.claimSymm.SETTER_ROLE(),
		await context.claimSymm.MINTER_ROLE(),
		await context.claimSymm.PAUSER_ROLE(),
		await context.claimSymm.UNPAUSER_ROLE(),
	]
	for (const role of roles) await context.claimSymm.grantRole(role, await context.signers.admin.getAddress())

	await context.symmioToken.grantRole(await context.symmioToken.MINTER_ROLE(), await context.claimSymm.getAddress())
	await context.symmioToken.grantRole(await context.symmioToken.MINTER_ROLE(), await context.signers.admin.getAddress())
	await context.symmStaking.grantRole(await context.symmStaking.REWARD_MANAGER_ROLE(), await context.signers.admin.getAddress());

	return context
}
