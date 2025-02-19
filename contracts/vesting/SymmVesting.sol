// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./Vesting.sol";
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
	// Error
	//--------------------------------------------------------------------------

	error SlippageExceeded();

	//--------------------------------------------------------------------------
	// Constants
	//--------------------------------------------------------------------------

	IPool public constant POOL = IPool(address(0x0000000000000000000000000000000000000000));
	IRouter public constant ROUTER = IRouter(address(0x0000000000000000000000000000000000000000));
	address public constant VAULT = address(0x0000000000000000000000000000000000000000);
	address public constant SYMM = address(0x800822d361335b4d5F352Dac293cA4128b5B605f);
	address public constant SYMM_LP = address(0x0000000000000000000000000000000000000000);

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
	// LP for vesting function
	//--------------------------------------------------------------------------

	/// @notice Adds liquidity by converting a portion of SYMM vesting into SYMM LP tokens.
	/// @dev Claims any unlocked tokens from SYMM and SYMM LP vesting plans.
	///      Reverts if the SYMM vesting plan's locked amount is insufficient.
	/// @param amount The amount of SYMM to use for adding liquidity.
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
		lpVestingPlan.resetAmount(lpVestingPlan.lockedAmount() + lpAmount);

		emit LiquidityAdded(msg.sender, amount, amountsIn[1], lpAmount);
	}

	/// @notice Internal function that adds liquidity using the provided SYMM amount.
	/// @dev Transfers USDC from the caller and approves token spending for the VAULT.
	/// @param symmIn The amount of SYMM to contribute.
	/// @return amountsIn Array of token amounts used (SYMM and USDC).
	/// @return lpAmount The amount of LP tokens minted.
	function _addLiquidity(uint256 symmIn, uint256 minLpAmount) internal returns (uint256[] memory amountsIn, uint256 lpAmount) {
		(uint256 usdcIn, uint256 expectedLpAmount) = neededUSDCForLiquidity(symmIn);

		uint256 minLpAmountWithSlippage = minLpAmount > 0 ? minLpAmount : (expectedLpAmount * 95) / 100; // Default 5% slippage if not specified

		// Retrieve pool tokens. Assumes poolTokens[0] is SYMM and poolTokens[1] is USDC.
		IERC20[] memory poolTokens = POOL.getTokens();
		(IERC20 symm, IERC20 usdc) = (poolTokens[0], poolTokens[1]);

		// Pull USDC from the user and approve the VAULT.
		usdc.transferFrom(msg.sender, address(this), usdcIn);
		usdc.approve(VAULT, usdcIn);
		symm.approve(VAULT, symmIn);

		amountsIn = new uint256[](2);
		amountsIn[0] = symmIn;
		amountsIn[1] = usdcIn;

		uint256 initialLpBalance = IERC20(SYMM_LP).balanceOf(address(this));

		// Call the router to add liquidity.
		amountsIn = ROUTER.addLiquidityProportional(
			address(POOL),
			amountsIn,
			minLpAmountWithSlippage,
			false, // wethIsEth: bool
			"" // userData: bytes
		);

		// Calculate actual LP tokens received by comparing balances
		uint256 newLpBalance = IERC20(SYMM_LP).balanceOf(address(this));
		lpAmount = newLpBalance - initialLpBalance;

		if (lpAmount < minLpAmountWithSlippage) revert SlippageExceeded();
	}

	/// @notice Calculates the USDC required and LP tokens expected for the provided SYMM amount.
	/// @param symmAmount The amount of SYMM.
	/// @return usdcAmount The USDC required.
	/// @return lpAmount The LP tokens that will be minted.
	function neededUSDCForLiquidity(uint256 symmAmount) public view returns (uint256 usdcAmount, uint256 lpAmount) {
		uint256[] memory balances = POOL.getCurrentLiveBalances();
		uint256 totalSupply = POOL.totalSupply();
		uint256 symmBalance = balances[0];
		uint256 usdcBalance = balances[1];

		// Calculate proportionate ratios based on SYMM balance.
		uint256 symmRatio = (symmAmount * 1e18) / symmBalance;
		usdcAmount = (symmRatio * usdcBalance) / 1e18;
		lpAmount = (symmRatio * totalSupply) / 1e18;
	}
}
