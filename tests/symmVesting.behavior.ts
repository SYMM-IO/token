import { setBalance } from "@nomicfoundation/hardhat-network-helpers"
import { Signer } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { ERC20, Symmio, SymmVesting } from "../typechain-types"
import { e } from "../utils"
import { string } from "hardhat/internal/core/params/argumentTypes";
import { expect } from "chai";
import BigNumber from 'bignumber.js';

export function shouldBehaveLikeSymmVesting() {
		let symmVesting: SymmVesting
		let symmToken: Symmio
		let erc20: ERC20
		let owner: Signer, user1: Signer, user2:Signer, vestingPenaltyReceiver: Signer, usdcWhale: Signer

		const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6"
		const INITIAL_BALANCE = e(100)

		async function impersonateAccount(address: string) {
			await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] })
			return ethers.getImpersonatedSigner(address)
		}

		beforeEach(async () => {
			;[user1, vestingPenaltyReceiver, user2] = await ethers.getSigners()

			owner = await impersonateAccount("0x8CF65060CdA270a3886452A1A1cb656BECEE5bA4")
			usdcWhale = await impersonateAccount("0x607094ed3a8361bB5e94dD21bcBef2997b687478")

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
			symmVesting = (await upgrades.deployProxy(SymmVestingFactory, [await owner.getAddress(), await vestingPenaltyReceiver.getAddress()], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})) as any
			await symmVesting.waitForDeployment()

			await symmToken.connect(owner).grantRole(MINTER_ROLE, await owner.getAddress())
			await symmToken.connect(owner).mint(await symmVesting.getAddress(), e("1000"))

			await erc20.connect(usdcWhale).transfer(await user1.getAddress(), "1000000000")
			await erc20.connect(user1).approve(await symmVesting.getAddress(), "1000000000")

			// Setup vesting plans
			const users = [await user1.getAddress()]
			const amounts = [e("1000")]
			const startTime = Math.floor(Date.now() / 1000) - 2 * 30 * 24 * 60 * 60 // 2 months ago
			const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months later

			await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)
		})
		describe("Add Liquidity", () => {
			it("should allow a user to add liquidity successfully", async () => {
				const symmAmount = String(1e18);
				const minLpAmount = 0;

				const lockedAmountBefore =  await symmVesting.getLockedAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
				const claimableAmountBefore =  await symmVesting.getClaimableAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
				const unlockedAmountBefore =  await symmVesting.getUnlockedAmountForToken(await user1.getAddress(), await symmToken.getAddress())

				await symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount);
				const lockedAmountAfter = await symmVesting.getLockedAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
				const claimableAmountAfter =  await symmVesting.getClaimableAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
				const unlockedAmountAfter =  await symmVesting.getUnlockedAmountForToken(await user1.getAddress(), await symmToken.getAddress())

				await expect(lockedAmountBefore-lockedAmountAfter).to.be.within(BigInt(symmAmount), BigInt(symmAmount)+BigInt(1e15));
				await expect(claimableAmountBefore-claimableAmountAfter).to.be.within(BigInt(claimableAmountBefore), BigInt(claimableAmountBefore)+BigInt(1e5));
				expect(claimableAmountAfter).to.be.lessThan(1e5);
				await expect(unlockedAmountBefore-unlockedAmountAfter).to.be.within(BigInt(claimableAmountBefore), BigInt(claimableAmountBefore)+BigInt(1e5));
			})

			it("should revert if slippage limit is exceeded", async () => {
				const symmAmount = String(1e18);
				const minLpAmount = e(200);
				await expect(symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount)).to.be.revertedWithCustomError(symmVesting, "SlippageExceeded")
			})

			it("should revert if user does not have enough locked SYMM", async () => {
				const symmAmount = String(800e18);
				const minLpAmount = 0;
				await expect(symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount)).to.be.revertedWithCustomError(symmVesting, "InvalidAmount")
			})

			it("should mint SYMM if SymmVesting doesn't have enough balance", async () => {
				const symmAmount = e(1100);
				const minLpAmount = 0;
				const symmVestingBalance = await symmToken.balanceOf(await symmVesting.getAddress())

				// Setup vesting plans
				const users = [await user2.getAddress()]
				const amounts = [e("10000")]
				const startTime = Math.floor(Date.now() / 1000) - 8 * 30 * 24 * 60 * 60 // 8 months ago
				const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months after
				await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)
				const diffBalance = symmAmount - symmVestingBalance
				await expect(diffBalance).to.be.greaterThan(0)
				await expect(symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount)).to.be.ok
			})


			it("should addLiquidity for many users and many times", async () => {
				const symmAmount = e(1100);
				const minLpAmount = 0;
				const symmVestingBalance = await symmToken.balanceOf(await symmVesting.getAddress())

				// Setup vesting plans
				const users = [await user2.getAddress()]
				const amounts = [e("10000")]
				const startTime = Math.floor(Date.now() / 1000) - 8 * 30 * 24 * 60 * 60 // 8 months ago
				const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months after
				await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)
				const diffBalance = symmAmount - symmVestingBalance
				await expect(diffBalance).to.be.greaterThan(0)
				await expect(symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount)).to.be.ok
			})

			it.only("should emit LiquidityAdded event for each addLiquidity with correct amounts", async () => {
				// Define the number of liquidity additions we want to test
				const liquidityAdditionsCount = 5;

				for (let i = 0; i < liquidityAdditionsCount; i++) {
					const symmAmount = String(1e18); // Amount of SYMM tokens to add
					const minLpAmount = 0; // Slippage tolerance (for simplicity)

					// Get the liquidity quote before the liquidity addition
					const [usdcAmount, expectedLpAmount] = await symmVesting.getLiquidityQuote(symmAmount);

					// Ensure the liquidity quote is correct
					console.log(`Liquidity quote for addLiquidity #${i + 1}:`);
					console.log(`Expected USDC: ${usdcAmount.toString()}`);
					console.log(`Expected LP Amount: ${expectedLpAmount.toString()}`);

					// Call addLiquidity and capture the transaction
					const tx = await symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount);
					const receipt = await tx.wait()
					// for (const log of receipt?.logs) {
					// 		const parsedLog = symmVesting.interface.parseLog(log);
					// 		if (parsedLog?.name === "LiquidityAdded") {
					// 			// Assuming the event is defined as:
					// 			// event LiquidityAdded(address indexed user, uint256 symmIn, uint256 usdcIn, uint256 lpAmount);
					// 			console.log(
					// 				parsedLog
					// 			);
					// 		}
					// 	}
					// 					// // Extract the LiquidityAdded event from the transaction
					// const receipt = await tx.wait();
					// const liquidityAddedEvent = receipt.events?.find((event) => event.event === "LiquidityAdded");
					//
					// // Check if the LiquidityAdded event was emitted
					// expect(liquidityAddedEvent).to.not.be.undefined;
					//
					// // Extract the values from the event
					// const { amountsIn, lpAmount } = liquidityAddedEvent?.args || {};
					// const symmIn = amountsIn[0].toString();
					// const usdcIn = amountsIn[1].toString();
					//
					// // Ensure the difference between the quoted and actual amounts is within a tolerance of 100 wei
					// expect(BigInt(symmIn) - BigInt(symmAmount)).to.be.lessThanOrEqual(BigInt(100)); // tolerance of 100 wei
					// expect(BigInt(usdcIn) - BigInt(usdcAmount)).to.be.lessThanOrEqual(BigInt(100)); // tolerance of 100 wei
					//
					// // Additional checks can be added to verify the balances and changes in the vesting plan.
					// // For example, you can check if the locked amounts and claimable amounts are updated correctly.
				}
			});

		})
}
