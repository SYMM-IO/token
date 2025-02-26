import { setBalance } from "@nomicfoundation/hardhat-network-helpers"
import { Signer } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { ERC20, Symmio, SymmVesting } from "../typechain-types"
import { e } from "../utils"
import { string } from "hardhat/internal/core/params/argumentTypes";
import { expect } from "chai";
import BigNumber from 'bignumber.js';
import { max, min } from "lodash";

export function shouldBehaveLikeSymmVesting() {
	let symmVesting: SymmVesting
	let symmToken: Symmio
	let erc20: ERC20
	let owner: Signer, user1: Signer, user2: Signer, vestingPenaltyReceiver: Signer, usdcWhale: Signer

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
		await symmToken.connect(owner).mint(await symmVesting.getAddress(), e("100000000000"))

		await erc20.connect(usdcWhale).transfer(await user1.getAddress(), "1000000000")
		await erc20.connect(user1).approve(await symmVesting.getAddress(), "1000000000")

		// Setup vesting plans
		const users = [await user1.getAddress()]
		const amounts = [e("100000000000")]
		const startTime = Math.floor(Date.now() / 1000) - 2 * 30 * 24 * 60 * 60 // 2 months ago
		const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months later

		await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)
	})
	describe("Add Liquidity", () => {
		it("should allow a user to add liquidity successfully", async () => {
			const symmAmount = String(1e18);
			const minLpAmount = 0;

			const lockedAmountBefore = await symmVesting.getLockedAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
			const claimableAmountBefore = await symmVesting.getClaimableAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
			const unlockedAmountBefore = await symmVesting.getUnlockedAmountForToken(await user1.getAddress(), await symmToken.getAddress())

			await symmVesting.connect(user1).addLiquidity(symmAmount, minLpAmount);
			const lockedAmountAfter = await symmVesting.getLockedAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
			const claimableAmountAfter = await symmVesting.getClaimableAmountsForToken(await user1.getAddress(), await symmToken.getAddress())
			const unlockedAmountAfter = await symmVesting.getUnlockedAmountForToken(await user1.getAddress(), await symmToken.getAddress())

			await expect(lockedAmountBefore - lockedAmountAfter).to.be.within(BigInt(symmAmount), BigInt(symmAmount) + BigInt(1e15));
			await expect(claimableAmountBefore - claimableAmountAfter).to.be.within(BigInt(claimableAmountBefore), BigInt(claimableAmountBefore) + BigInt(1e5));
			expect(claimableAmountAfter).to.be.lessThan(1e5);
			await expect(unlockedAmountBefore - unlockedAmountAfter).to.be.within(BigInt(claimableAmountBefore), BigInt(claimableAmountBefore) + BigInt(1e5));
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
			const liquidityAdditionsCount = BigInt(100);

			// Setup vesting plans
			const users = [await user2.getAddress()]
			const amounts = [e(1e15)]
			const startTime = Math.floor(Date.now() / 1000) - 1 * 30 * 24 * 60 * 60 // 1 months ago
			const endTime = startTime + 9 * 30 * 24 * 60 * 60 // 9 months later
			await symmVesting.connect(owner).setupVestingPlans(await symmToken.getAddress(), startTime, endTime, users, amounts)

			await symmToken.connect(owner).grantRole(MINTER_ROLE, await symmVesting.getAddress())

			const usdcTransferAmount = String(1e14);
			await erc20.connect(usdcWhale).transfer(await user2.getAddress(), usdcTransferAmount)
			await erc20.connect(user2).approve(await symmVesting.getAddress(), usdcTransferAmount)

			const minVal = e(0.1);
			const maxVal = e(1e5);
			const totalMax = e(1e12);


			// Check feasibility: if even the minimum for every element would exceed the total allowed.
			if (liquidityAdditionsCount * minVal > totalMax) {
				throw new Error("Cannot generate amounts: minimum sum exceeds total maximum allowed");
			}

			const symmAmountList = [];
			const minLpAmountList = [];
			let currentSum = BigInt(0);

			/**
			 * Returns a random BigInt in the range [0, n)
			 * using rejection sampling and 32-bit chunks.
			 */
			function randomBigInt(n) {
				if (n <= BigInt(0)) return BigInt(0);
				const bits = n.toString(2).length;
				let result;
				while (true) {
					let r = BigInt(0);
					// Calculate how many 32-bit chunks we need.
					const numChunks = Math.ceil(bits / 32);
					for (let i = 0; i < numChunks; i++) {
						// Generate a random 32-bit chunk.
						const random32 = BigInt(Math.floor(Math.random() * 4294967296));
						r = (r << BigInt(32)) + random32;
					}
					if (r < n) {
						result = r;
						break;
					}
				}
				return result;
			}
			let sumUsdcDiff = Number(0);
			let sumSymmDiff = Number(0);
			let sumLPDiff = Number(0);

			let sumUsdcIn = BigInt(0);
			let sumSymmIn = BigInt(0);
			let sumLPOut = BigInt(0);



			for (let i = 0; i < Number(liquidityAdditionsCount); i++) {
				const remainingCount = liquidityAdditionsCount - BigInt(i);
				// Reserve the minimum for all remaining elements (excluding current one)
				const reserved = (remainingCount - BigInt(1)) * minVal;
				// Maximum allowed for this iteration without breaking the total constraint:
				const allowed = totalMax - currentSum - reserved;
				// Use the smaller of allowed and maxVal:
				const maxAllowedForThis = allowed < maxVal ? allowed : maxVal;

				// Compute the range width (inclusive) and generate a random increment
				const range = maxAllowedForThis - minVal + BigInt(1);
				const randomIncrement = randomBigInt(range);
				const value = minVal + randomIncrement;

				symmAmountList.push(value.toString());
				minLpAmountList.push("0");
				currentSum += value;
			}

			// let symmAmountListCopy = symmAmountList.map(value => String(Number(value)/Number(1e18)))
			// console.log("SYMM Amount List:", symmAmountListCopy);
			// console.log("minLp Amount List:", minLpAmountList);


			for (let i = 0; i < liquidityAdditionsCount; i++) {
				const symmAmount = symmAmountList[i]
				const minLpAmount = minLpAmountList[i]
				// Get the liquidity quote before the liquidity addition
				const [usdcAmount, expectedLpAmount] = await symmVesting.connect(user2).getLiquidityQuote(symmAmount);


				// Call addLiquidity and capture the transaction
				const tx = await symmVesting.connect(user2).addLiquidity(symmAmount, minLpAmount, usdcTransferAmount);
				const receipt = await tx.wait()
				for (const log of receipt?.logs) {
					const parsedLog = symmVesting.interface.parseLog(log);
					if (parsedLog?.name === "LiquidityAdded") {
						const msg_sender = parsedLog.args[0]
						const symmIn = parsedLog.args[1]
						const usdcIn = parsedLog.args[2]
						const lpOut = parsedLog.args[3]
						sumUsdcDiff += Number(usdcIn)-Number(usdcAmount)
						sumSymmDiff += Number(symmIn)-Number(symmAmount)
						sumLPDiff += Number(lpOut)-Number(expectedLpAmount)

						sumUsdcIn += usdcIn;
						sumSymmIn += symmIn;
						sumLPOut += lpOut;

						expect(usdcAmount).to.be.closeTo(usdcIn, 5)
						expect(symmAmount).to.be.closeTo(symmIn, 5)
						expect(expectedLpAmount).to.be.closeTo(lpOut, 5)
					}
				}
			}
			console.log(sumLPDiff, sumSymmDiff, sumUsdcDiff)
			// console.log(Number(sumLPOut)/Number(1e18), Number(sumSymmIn, Number(sumUsdcIn)/Number(1e6))
			// console.log(Number(sumLPOut)/Number(1e18)/Number(liquidityAdditionsCount), Number(sumSymmIn)/Number(1e18)/Number(liquidityAdditionsCount), Number(sumUsdcIn)/Number(1e6)/Number(liquidityAdditionsCount))
			// console.log(min(symmAmountListCopy), max(symmAmountListCopy))

			expect(sumUsdcDiff).to.be.closeTo(0, liquidityAdditionsCount)
			expect(sumSymmDiff).to.be.closeTo(0, liquidityAdditionsCount)
			expect(sumLPDiff).to.be.closeTo(0, liquidityAdditionsCount)
		}).timeout(500000);
	})

	//TODO: add test for after end time test
	//TODO: test it returns usdc/symm
	//TODO: add test for maxUsdcIn
}