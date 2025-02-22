import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { ERC20, Symmio, SymmVesting } from "../typechain-types"
import { Signer } from "ethers"
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { e } from "../utils";
import { increase } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";

// Helper function to parse ether values
const toEther = (value: string) => ethers.parseEther(value)

describe("SymmVesting - addLiquidity", () => {
	let symmVesting: SymmVesting
	let symmToken: Symmio
	let erc20: ERC20
	let owner: Signer, user1: Signer, vestingPenaltyReceiver: Signer, usdcWhale: Signer

	const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6"
	const INITIAL_BALANCE = toEther("100")
	const SYMM_AMOUNT = "99999999999999999250"
	const MIN_LP_AMOUNT = "0"

	async function impersonateAccount(address: string) {
		await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] })
		return ethers.getImpersonatedSigner(address)
	}

	beforeEach(async () => {
		;[user1, vestingPenaltyReceiver] = await ethers.getSigners()

		owner = await impersonateAccount("0x8CF65060CdA270a3886452A1A1cb656BECEE5bA4")
		usdcWhale = await impersonateAccount("0x6D5f64FB9c634b3cE3Ffd67035D9B70654fE1442")

		await setBalance(await owner.getAddress(), INITIAL_BALANCE)
		await setBalance(await usdcWhale.getAddress(), INITIAL_BALANCE)

		const TokenFactory = await ethers.getContractFactory("Symmio")
		const ERC20Factory = await ethers.getContractFactory("MockERC20")
		symmToken = TokenFactory.attach("0x800822d361335b4d5F352Dac293cA4128b5B605f") as Symmio
		erc20 = ERC20Factory.attach("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") as ERC20

		const VestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
		const vestingPlanOps = await VestingPlanOps.deploy()
		await vestingPlanOps.waitForDeployment()

		const SymmVestingFactory = await ethers.getContractFactory("SymmVesting", {
			libraries: { VestingPlanOps: await vestingPlanOps.getAddress() },
		})
		const proxy = await upgrades.deployProxy(SymmVestingFactory, [await owner.getAddress(), await vestingPenaltyReceiver.getAddress()], {
			unsafeAllow: ["external-library-linking"],
			initializer: "initialize",
		})
		symmVesting = (await proxy.waitForDeployment()) as SymmVesting

		await symmToken.connect(owner).grantRole(MINTER_ROLE, await owner.getAddress())
		await symmToken.connect(owner).mint(await symmVesting.getAddress(), e("1000"))

		await erc20.connect(usdcWhale).transfer(await user1.getAddress(), "1000000000")
		await erc20.connect(user1).approve(await symmVesting.getAddress(), "1000000000")

		// Setup vesting plans
		const users = [await user1.getAddress()]
		const amounts = [e("1000")]
		const startTime = Math.floor(Date.now() / 1000) - 2 * 30 * 24 * 60 * 60; // 2 months ago
		const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months later

		await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)
	})

	it("should allow a user to add liquidity successfully", async () => {
		await symmVesting.connect(user1).addLiquidity(SYMM_AMOUNT, MIN_LP_AMOUNT)
		const lpBalance = await symmVesting.vestingPlans(await symmVesting.SYMM_LP(), await user1.getAddress())
		// expect(lpBalance.lockedAmount).to.be.greaterThan(0)
	})

	// it("should revert if slippage limit is exceeded", async () => {
	// 	await expect(symmVesting.connect(user1).addLiquidity(SYMM_AMOUNT, toEther("200"))).to.be.revertedWithCustomError(symmVesting, "SlippageExceeded")
	// })
	//
	// it("should revert if user does not have enough locked SYMM", async () => {
	// 	await expect(symmVesting.connect(user1).addLiquidity(toEther("10000"), MIN_LP_AMOUNT)).to.be.revertedWithCustomError(symmVesting, "InvalidAmount")
	// })
})
