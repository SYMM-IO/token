import { ethers, run } from "hardhat"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { e } from "../utils"
import { SymmAllocationClaimer, Symmio } from "../typechain-types"

export class RunContext {
	signers!: {
		admin: SignerWithAddress
		setter: SignerWithAddress
		user1: SignerWithAddress
		user2: SignerWithAddress
		symmioFoundation: SignerWithAddress
	}
	symmioToken!: Symmio
	claimSymm!: SymmAllocationClaimer
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

	const roles = [
		await context.claimSymm.SETTER_ROLE(),
		await context.claimSymm.MINTER_ROLE(),
		await context.claimSymm.PAUSER_ROLE(),
		await context.claimSymm.UNPAUSER_ROLE(),
	]
	for (const role of roles) await context.claimSymm.grantRole(role, await context.signers.admin.getAddress())

	await context.symmioToken.grantRole(await context.symmioToken.MINTER_ROLE(), await context.claimSymm.getAddress())

	return context
}
