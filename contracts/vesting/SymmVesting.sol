// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./Vesting.sol";
import "./interfaces/IPermit2.sol";
import "./interfaces/IMintableERC20.sol";
import { IPool } from "./interfaces/IPool.sol";
import { IRouter } from "./interfaces/IRouter.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title SymmVesting Contract
/// @notice Extends Vesting to add liquidity functionality for SYMM and SYMM LP tokens.
/// @dev Inherits pausable functionality and vesting plan management from Vesting.
contract SymmVesting is Vesting {
	using VestingPlanOps for VestingPlan;

	//--------------------------------------------------------------------------
	// Events
	//--------------------------------------------------------------------------

	/// @notice Emitted when liquidity is added.
	/// @param user The address adding liquidity.
	/// @param symmAmount The amount of SYMM used.
	/// @param usdcAmount The amount of USDC required.
	/// @param lpAmount The amount of LP tokens received.
	event LiquidityAdded(address indexed user, uint256 symmAmount, uint256 usdcAmount, uint256 lpAmount);

	//--------------------------------------------------------------------------
	// Errors
	//--------------------------------------------------------------------------

	error SlippageExceeded();
	error ZeroDivision();

	//--------------------------------------------------------------------------
	// Constants
	//--------------------------------------------------------------------------

	IPool public constant POOL = IPool(address(0x94Bf449AB92be226109f2Ed3CE2b297Db94bD995));
	IRouter public constant ROUTER = IRouter(address(0x76578ecf9a141296Ec657847fb45B0585bCDa3a6));
	IPermit2 public constant PERMIT2 = IPermit2(address(0x000000000022D473030F116dDEE9F6B43aC78BA3));
	address public constant VAULT = address(0xbA1333333333a1BA1108E8412f11850A5C319bA9);
	address public constant SYMM = address(0x800822d361335b4d5F352Dac293cA4128b5B605f);
	address public constant USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
	address public constant SYMM_LP = address(0x94Bf449AB92be226109f2Ed3CE2b297Db94bD995);

	//--------------------------------------------------------------------------
	// Initialization
	//--------------------------------------------------------------------------

	/// @notice Initializes the SymmVesting contract.
	/// @param admin Address to receive the admin and role assignments.
	/// @param _lockedClaimPenaltyReceiver Address that receives the locked claim penalty.
	function initialize(address admin, address _lockedClaimPenaltyReceiver) public initializer {
		__vesting_init(admin, 500000000000000000, _lockedClaimPenaltyReceiver);
	}

	//--------------------------------------------------------------------------
	// Liquidity for Vesting Functions
	//--------------------------------------------------------------------------

	/// @notice Adds liquidity by converting a portion of SYMM vesting into SYMM LP tokens.
	/// @dev Claims any unlocked tokens from SYMM and SYMM LP vesting plans.
	///      Reverts if the SYMM vesting plan's locked amount is insufficient.
	/// @param amount The amount of SYMM to use for adding liquidity.
	/// @param minLpAmount The minimum acceptable LP token amount to receive (for slippage protection).
	/// @return amountsIn Array of token amounts used (SYMM and USDC).
	/// @return lpAmount The amount of LP tokens minted.
	function addLiquidity(
		uint256 amount,
		uint256 minLpAmount
	) external whenNotPaused nonReentrant returns (uint256[] memory amountsIn, uint256 lpAmount) {
		// Claim any unlocked SYMM tokens first.
		_claimUnlockedToken(SYMM, msg.sender);

		VestingPlan storage symmVestingPlan = vestingPlans[SYMM][msg.sender];
		uint256 symmLockedAmount = symmVestingPlan.lockedAmount();
		if (symmLockedAmount <= amount) revert InvalidAmount();

		// Update SYMM vesting plan by reducing the locked amount.
		symmVestingPlan.resetAmount(symmLockedAmount - amount);

		// Add liquidity to the pool.
		(amountsIn, lpAmount) = _addLiquidity(amount, minLpAmount);

		// Claim any unlocked SYMM LP tokens.
		_claimUnlockedToken(SYMM_LP, msg.sender);

		VestingPlan storage lpVestingPlan = vestingPlans[SYMM_LP][msg.sender];
		// Increase the locked amount by the received LP tokens.
		if (lpVestingPlan.amount == 0) {
			lpVestingPlan.setup(lpAmount, block.timestamp, symmVestingPlan.endTime);
		} else {
			lpVestingPlan.resetAmount(lpVestingPlan.lockedAmount() + lpAmount);
		}

		emit LiquidityAdded(msg.sender, amountsIn[0], amountsIn[1], lpAmount);
	}

	/// @notice Internal function to add liquidity using a specified amount of SYMM.
	/// @dev Transfers USDC from the caller, approves token spending for the VAULT, and interacts with the liquidity router.
	/// @param symmIn The amount of SYMM to contribute.
	/// @param minLpAmount The minimum acceptable LP token amount to receive (for slippage protection).
	/// @return amountsIn Array containing the amounts of SYMM and USDC used.
	/// @return lpAmount The number of LP tokens minted.
	function _addLiquidity(uint256 symmIn, uint256 minLpAmount) internal returns (uint256[] memory amountsIn, uint256 lpAmount) {
		(uint256 usdcIn, uint256 expectedLpAmount) = getLiquidityQuote(symmIn);

		uint256 minLpAmountWithSlippage = minLpAmount > 0 ? minLpAmount : (expectedLpAmount * 95) / 100; // Default 5% slippage if not specified

		// Retrieve pool tokens. Assumes poolTokens[0] is SYMM and poolTokens[1] is USDC.
		IERC20[] memory poolTokens = POOL.getTokens();
		(IERC20 symm, IERC20 usdc) = (poolTokens[0], poolTokens[1]);

		// Pull USDC from the user and approve the VAULT.
		usdc.transferFrom(msg.sender, address(this), usdcIn);
		usdc.approve(address(PERMIT2), usdcIn);
		symm.approve(address(PERMIT2), symmIn);
		PERMIT2.approve(SYMM, address(ROUTER), uint160(symmIn), uint48(block.timestamp));
		PERMIT2.approve(USDC, address(ROUTER), uint160(usdcIn), uint48(block.timestamp));

		amountsIn = new uint256[](2);
		amountsIn[0] = symmIn;
		amountsIn[1] = usdcIn;

		uint256 initialLpBalance = IERC20(SYMM_LP).balanceOf(address(this));

		// Call the router to add liquidity.
		amountsIn = ROUTER.addLiquidityProportional(
			address(POOL),
			amountsIn,
			expectedLpAmount,
			false, // wethIsEth: bool
			"" // userData: bytes
		);

		// Calculate actual LP tokens received by comparing balances.
		uint256 newLpBalance = IERC20(SYMM_LP).balanceOf(address(this));
		lpAmount = newLpBalance - initialLpBalance;

		if (lpAmount < minLpAmountWithSlippage) revert SlippageExceeded();
	}

	/// @notice Calculates the ceiling of (a * b) divided by c.
	/// @dev Computes ceil(a * b / c) using the formula (a * b - 1) / c + 1 when the product is nonzero.
	///      Returns 0 if a * b equals 0.
	/// @param a The multiplicand.
	/// @param b The multiplier.
	/// @param c The divisor.
	/// @return result The smallest integer greater than or equal to (a * b) / c.
	function _mulDivUp(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 result) {
		// This check is required because Yul's div doesn't revert on c==0.
		if (c == 0) revert ZeroDivision();

		// Multiple overflow protection is done by Solidity 0.8.x.
		uint256 product = a * b;

		// The traditional divUp formula is:
		// divUp(x, y) := (x + y - 1) / y
		// To avoid intermediate overflow in the addition, we distribute the division and get:
		// divUp(x, y) := (x - 1) / y + 1
		// Note that this requires x != 0, if x == 0 then the result is zero
		//
		// Equivalent to:
		// result = a == 0 ? 0 : (a * b - 1) / c + 1
		assembly ("memory-safe") {
			result := mul(iszero(iszero(product)), add(div(sub(product, 1), c), 1))
		}
	}

	/// @notice Calculates the USDC required and LP tokens expected for a given SYMM amount.
	/// @dev Uses current pool balances and total supply to compute the liquidity parameters.
	/// @param symmAmount The amount of SYMM.
	/// @return usdcAmount The USDC required.
	/// @return lpAmount The LP tokens that will be minted.
	function getLiquidityQuote(uint256 symmAmount) public view returns (uint256 usdcAmount, uint256 lpAmount) {
		uint256[] memory balances = POOL.getCurrentLiveBalances();
		uint256 totalSupply = POOL.totalSupply();
		uint256 symmBalance = balances[0];
		uint256 usdcBalance = balances[1];

		usdcAmount = (symmAmount * usdcBalance) / symmBalance;
		usdcAmount = _mulDivUp(usdcAmount, 1e18, 1e30);
		lpAmount = (symmAmount * totalSupply) / symmBalance;
	}

	function _mintTokenIfPossible(address token, uint256 amount) internal override {
		if (token == SYMM) IMintableERC20(token).mint(address(this), amount);
	}
}
