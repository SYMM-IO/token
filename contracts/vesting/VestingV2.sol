// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/**
 * @title  VestingV2
 * @notice Advanced token vesting contract with linear vesting schedules, penalty mechanisms,
 *         and comprehensive claim options. Supports multiple vesting plans per user per token
 *         with flexible claiming of both unlocked and locked tokens.
 *
 * @dev    Core features include:
 *         • Multiple vesting plans per user per token with unique plan IDs
 *         • Linear vesting schedules with configurable start and end times
 *         • Unlocked token claiming for fully vested amounts
 *         • Locked token claiming with configurable penalty rates for early withdrawal
 *         • Percentage-based claiming for flexible withdrawal amounts
 *         • Plan reset functionality with automatic unlocked token claiming
 *         • Role-based access control for plan management and operations
 *         • Virtual minting hooks for token supply management
 *         • Comprehensive view functions for vesting analytics and monitoring
 *         • Upgradeable architecture with proper storage gap management
 *
 *         The contract integrates with LibVestingPlan for vesting calculations and uses
 *         OpenZeppelin's upgradeable contracts for security and access control.
 */

import { VestingPlanOps, VestingPlan } from "./libraries/LibVestingPlan.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract VestingV2 is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20;
	using VestingPlanOps for VestingPlan;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for setting up and resetting vesting plans.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for claiming tokens on behalf of users.
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	/// @notice Role for pausing contract operations.
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing contract operations.
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice Triple mapping storing vesting plan details: token => user => planId => VestingPlan.
	mapping(address => mapping(address => mapping(uint256 => VestingPlan))) public vestingPlans;

	/// @notice Double mapping tracking number of vesting plans: token => user => count.
	mapping(address => mapping(address => uint256)) public userVestingPlanCount;

	/// @notice Mapping tracking total vested amount per token across all plans.
	mapping(address => uint256) public totalVested;

	/// @notice Penalty rate for claiming locked tokens early (scaled by 1e18).
	/// @dev Example: 0.1e18 represents a 10% penalty on early claims.
	uint256 public lockedClaimPenalty;

	/// @notice Address that receives penalties from early claims of locked tokens.
	address public lockedClaimPenaltyReceiver;

	/// @dev Reserved storage slots for future upgrades to prevent storage collisions.
	uint256[50] private __gap;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/**
	 * @notice Emitted when a new vesting plan is created for a user.
	 * @param token     Address of the token being vested.
	 * @param user      Address of the user receiving the vesting plan.
	 * @param planId    ID of the vesting plan.
	 * @param amount    Total amount of tokens in the vesting plan.
	 * @param startTime Start time of the vesting period.
	 * @param endTime   End time of the vesting period.
	 */
	event VestingPlanSetup(address indexed token, address indexed user, uint256 indexed planId, uint256 amount, uint256 startTime, uint256 endTime);

	/**
	 * @notice Emitted when a vesting plan is reset with a new amount.
	 * @param token     Address of the token being vested.
	 * @param user      Address of the user whose plan is reset.
	 * @param planId    ID of the vesting plan.
	 * @param newAmount New total amount of tokens in the vesting plan.
	 */
	event VestingPlanReset(address indexed token, address indexed user, uint256 indexed planId, uint256 newAmount);

	/**
	 * @notice Emitted when unlocked tokens are claimed from a vesting plan.
	 * @param token  Address of the token being claimed.
	 * @param user   Address of the user claiming the tokens.
	 * @param planId ID of the vesting plan.
	 * @param amount Amount of tokens claimed.
	 */
	event UnlockedTokenClaimed(address indexed token, address indexed user, uint256 indexed planId, uint256 amount);

	/**
	 * @notice Emitted when locked tokens are claimed with a penalty.
	 * @param token   Address of the token being claimed.
	 * @param user    Address of the user claiming the tokens.
	 * @param planId  ID of the vesting plan.
	 * @param amount  Total amount of tokens claimed (before penalty).
	 * @param penalty Penalty amount deducted from the claim.
	 */
	event LockedTokenClaimed(address indexed token, address indexed user, uint256 indexed planId, uint256 amount, uint256 penalty);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error MismatchArrays(); // input arrays have mismatched lengths
	error InvalidAmount(); // invalid amount provided (e.g., exceeds locked amount)
	error ZeroAddress(); // zero address provided for critical parameters
	error InvalidPlanId(); // invalid vesting plan ID provided

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/**
	 * @notice Initialize the vesting contract with initial configuration.
	 * @param admin                        Address to receive admin and all role assignments.
	 * @param _lockedClaimPenalty          Penalty rate for early claims (scaled by 1e18).
	 * @param _lockedClaimPenaltyReceiver  Address to receive penalties from early claims.
	 *
	 * @dev Sets up access control, pausing, and reentrancy guard. Validates addresses
	 *      to prevent zero-address configuration.
	 */
	function __vesting_init(address admin, uint256 _lockedClaimPenalty, address _lockedClaimPenaltyReceiver) public onlyInitializing {
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		lockedClaimPenalty = _lockedClaimPenalty;
		lockedClaimPenaltyReceiver = _lockedClaimPenaltyReceiver;

		// Validate addresses to prevent zero-address configuration
		if (admin == address(0) || _lockedClaimPenaltyReceiver == address(0)) revert ZeroAddress();

		// Grant all roles to the admin
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SETTER_ROLE, admin);
		_grantRole(PAUSER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);
		_grantRole(OPERATOR_ROLE, admin);
	}

	/* ────────────────────── Pausing Functions ────────────────────── */

	/**
	 * @notice Pause the contract, disabling state-changing functions.
	 * @dev Only callable by accounts with PAUSER_ROLE.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpause the contract, enabling state-changing functions.
	 * @dev Only callable by accounts with UNPAUSER_ROLE.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/* ────────────── Vesting Plan Management ────────────── */

	/**
	 * @notice Set up vesting plans for multiple users with specified parameters.
	 * @param token     Address of the token to vest.
	 * @param startTime Start time of the vesting period.
	 * @param endTime   End time of the vesting period.
	 * @param users     Array of user addresses to receive vesting plans.
	 * @param amounts   Array of token amounts for each vesting plan.
	 *
	 * @dev Creates new vesting plans with sequential plan IDs. Tokens must be available
	 *      in the contract or minting hook must handle deficits.
	 */
	function setupVestingPlans(
		address token,
		uint256 startTime,
		uint256 endTime,
		address[] memory users,
		uint256[] memory amounts
	) external onlyRole(SETTER_ROLE) whenNotPaused nonReentrant {
		_setupVestingPlans(token, startTime, endTime, users, amounts);
	}

	/**
	 * @notice Reset existing vesting plans for multiple users with new amounts.
	 * @param token    Address of the token being vested.
	 * @param users    Array of user addresses whose plans are being reset.
	 * @param planIds  Array of vesting plan IDs to reset.
	 * @param amounts  Array of new token amounts for each plan.
	 *
	 * @dev Claims any unlocked tokens before resetting. Validates plan ID existence.
	 */
	function resetVestingPlans(
		address token,
		address[] memory users,
		uint256[] memory planIds,
		uint256[] memory amounts
	) external onlyRole(SETTER_ROLE) whenNotPaused nonReentrant {
		_resetVestingPlans(token, users, planIds, amounts);
	}

	/* ───────────────── Token Claim Functions ───────────────── */

	/**
	 * @notice Claim unlocked tokens for the caller from a specific vesting plan.
	 * @param token  Address of the token to claim.
	 * @param planId ID of the vesting plan.
	 *
	 * @dev Claims only fully vested tokens without penalty.
	 */
	function claimUnlockedToken(address token, uint256 planId) external whenNotPaused nonReentrant {
		_claimUnlockedToken(token, msg.sender, planId);
	}

	/**
	 * @notice Claim unlocked tokens on behalf of a user from a specific vesting plan.
	 * @param token  Address of the token to claim.
	 * @param user   Address of the user to claim for.
	 * @param planId ID of the vesting plan.
	 *
	 * @dev Only callable by accounts with OPERATOR_ROLE.
	 */
	function claimUnlockedTokenFor(address token, address user, uint256 planId) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
		_claimUnlockedToken(token, user, planId);
	}

	/**
	 * @notice Claim locked tokens for the caller with penalty deduction.
	 * @param token  Address of the token to claim.
	 * @param planId ID of the vesting plan.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Claims unlocked tokens first, then processes locked amount with penalty.
	 */
	function claimLockedToken(address token, uint256 planId, uint256 amount) external whenNotPaused nonReentrant {
		_claimLockedToken(token, msg.sender, planId, amount);
	}

	/**
	 * @notice Claim a percentage of locked tokens for the caller.
	 * @param token      Address of the token to claim.
	 * @param planId     ID of the vesting plan.
	 * @param percentage Percentage of locked tokens to claim (scaled by 1e18).
	 *
	 * @dev Calculates claim amount based on percentage of current locked balance.
	 */
	function claimLockedTokenByPercentage(address token, uint256 planId, uint256 percentage) external whenNotPaused nonReentrant {
		uint256 lockedAmount = getLockedAmountForPlan(msg.sender, token, planId);
		uint256 amountToClaim = (lockedAmount * percentage) / 1e18;
		_claimLockedToken(token, msg.sender, planId, amountToClaim);
	}

	/**
	 * @notice Claim locked tokens on behalf of a user with penalty deduction.
	 * @param token  Address of the token to claim.
	 * @param user   Address of the user to claim for.
	 * @param planId ID of the vesting plan.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Only callable by accounts with OPERATOR_ROLE.
	 */
	function claimLockedTokenFor(
		address token,
		address user,
		uint256 planId,
		uint256 amount
	) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
		_claimLockedToken(token, user, planId, amount);
	}

	/**
	 * @notice Claim a percentage of locked tokens on behalf of a user.
	 * @param token      Address of the token to claim.
	 * @param user       Address of the user to claim for.
	 * @param planId     ID of the vesting plan.
	 * @param percentage Percentage of locked tokens to claim (scaled by 1e18).
	 *
	 * @dev Only callable by accounts with OPERATOR_ROLE.
	 */
	function claimLockedTokenForByPercentage(
		address token,
		address user,
		uint256 planId,
		uint256 percentage
	) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
		uint256 lockedAmount = getLockedAmountForPlan(user, token, planId);
		uint256 amountToClaim = (lockedAmount * percentage) / 1e18;
		_claimLockedToken(token, user, planId, amountToClaim);
	}

	/* ───────────────────────── Internal Helpers ───────────────────────── */

	/**
	 * @dev Internal function to set up vesting plans for multiple users.
	 * @param token     Address of the token to vest.
	 * @param startTime Start time of the vesting period.
	 * @param endTime   End time of the vesting period.
	 * @param users     Array of user addresses.
	 * @param amounts   Array of token amounts for each vesting plan.
	 *
	 * @dev Creates sequential plan IDs and updates total vested amounts.
	 */
	function _setupVestingPlans(address token, uint256 startTime, uint256 endTime, address[] memory users, uint256[] memory amounts) internal {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		// Iterate through users to set up individual vesting plans
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 amount = amounts[i];
			uint256 planId = userVestingPlanCount[token][user];

			// Update total vested amount and create new vesting plan
			totalVested[token] += amount;
			VestingPlan storage vestingPlan = vestingPlans[token][user][planId];
			vestingPlan.setup(amount, startTime, endTime);

			// Increment plan count for the user
			userVestingPlanCount[token][user]++;
			emit VestingPlanSetup(token, user, planId, amount, startTime, endTime);
		}
	}

	/**
	 * @dev Internal function to reset vesting plans for multiple users.
	 * @param token    Address of the token being vested.
	 * @param users    Array of user addresses.
	 * @param planIds  Array of vesting plan IDs to reset.
	 * @param amounts  Array of new token amounts.
	 *
	 * @dev Claims unlocked tokens before resetting and updates total vested amounts.
	 */
	function _resetVestingPlans(address token, address[] memory users, uint256[] memory planIds, uint256[] memory amounts) internal {
		if (users.length != amounts.length || users.length != planIds.length) revert MismatchArrays();
		uint256 len = users.length;
		// Iterate through users to reset vesting plans
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 planId = planIds[i];
			uint256 amount = amounts[i];

			if (planId >= userVestingPlanCount[token][user]) revert InvalidPlanId();

			// Claim any unlocked tokens before resetting
			_claimUnlockedToken(token, user, planId);

			VestingPlan storage vestingPlan = vestingPlans[token][user][planId];
			uint256 oldTotal = vestingPlan.lockedAmount() + vestingPlan.unlockedAmount(); // Total before reset
			vestingPlan.resetAmount(amount);
			// Update total vested amount
			totalVested[token] = totalVested[token] - oldTotal + amount;
			emit VestingPlanReset(token, user, planId, amount);
		}
	}

	/**
	 * @dev Ensure the contract has sufficient token balance, minting if necessary.
	 * @param token  Address of the token.
	 * @param amount Required amount of tokens.
	 *
	 * @dev Calls virtual minting hook if balance is insufficient.
	 */
	function _ensureSufficientBalance(address token, uint256 amount) internal virtual {
		uint256 currentBalance = IERC20(token).balanceOf(address(this));
		if (currentBalance < amount) {
			uint256 deficit = amount - currentBalance;
			// Attempt to mint tokens to cover the deficit
			_mintTokenIfPossible(token, deficit);
		}
	}

	/**
	 * @dev Virtual hook to mint tokens if supported by the token contract.
	 * @param token  Address of the token to mint.
	 * @param amount Amount of tokens to mint.
	 *
	 * @dev Default implementation is a no-op. Override in derived contracts to enable minting.
	 */
	function _mintTokenIfPossible(address token, uint256 amount) internal virtual {
		// No-op in base implementation
	}

	/**
	 * @dev Internal function to claim unlocked tokens from a vesting plan.
	 * @param token  Address of the token to claim.
	 * @param user   Address of the user claiming tokens.
	 * @param planId ID of the vesting plan.
	 *
	 * @dev Transfers claimable tokens and updates plan state and total vested amounts.
	 */
	function _claimUnlockedToken(address token, address user, uint256 planId) internal {
		if (planId >= userVestingPlanCount[token][user]) revert InvalidPlanId();
		VestingPlan storage vestingPlan = vestingPlans[token][user][planId];
		uint256 claimableAmount = vestingPlan.claimable();
		if (claimableAmount == 0) return;

		// Update vesting plan and total vested amount
		totalVested[token] -= claimableAmount;
		vestingPlan.claimedAmount += claimableAmount;

		// Ensure sufficient balance before transfer
		_ensureSufficientBalance(token, claimableAmount);
		IERC20(token).safeTransfer(user, claimableAmount);
		emit UnlockedTokenClaimed(token, user, planId, claimableAmount);
	}

	/**
	 * @dev Internal function to claim locked tokens with penalty deduction.
	 * @param token  Address of the token to claim.
	 * @param user   Address of the user claiming tokens.
	 * @param planId ID of the vesting plan.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Claims unlocked tokens first, then processes locked amount with penalty.
	 */
	function _claimLockedToken(address token, address user, uint256 planId, uint256 amount) internal {
		// Claim any unlocked tokens first
		_claimUnlockedToken(token, user, planId);

		if (planId >= userVestingPlanCount[token][user]) revert InvalidPlanId();
		VestingPlan storage vestingPlan = vestingPlans[token][user][planId];

		if (vestingPlan.lockedAmount() < amount) revert InvalidAmount();

		// Update vesting plan and total vested amount
		uint256 newTotalAmount = vestingPlan.amount - amount;
		vestingPlan.resetAmount(newTotalAmount);
		totalVested[token] -= amount;

		// Calculate and apply penalty
		uint256 penalty = (amount * lockedClaimPenalty) / 1e18;
		_ensureSufficientBalance(token, amount);
		IERC20(token).safeTransfer(user, amount - penalty);
		IERC20(token).safeTransfer(lockedClaimPenaltyReceiver, penalty);
		emit LockedTokenClaimed(token, user, planId, amount, penalty);
	}

	/* ────────────────────────── View Functions ────────────────────────── */

	/**
	 * @notice Get the locked token amount for a specific vesting plan.
	 * @param user   Address of the user.
	 * @param token  Address of the token.
	 * @param planId ID of the vesting plan.
	 * @return Amount of tokens still locked in the plan.
	 */
	function getLockedAmountForPlan(address user, address token, uint256 planId) public view returns (uint256) {
		if (planId >= userVestingPlanCount[token][user]) return 0;
		return vestingPlans[token][user][planId].lockedAmount();
	}

	/**
	 * @notice Get the claimable token amount for a specific vesting plan.
	 * @param user   Address of the user.
	 * @param token  Address of the token.
	 * @param planId ID of the vesting plan.
	 * @return Amount of tokens currently claimable from the plan.
	 */
	function getClaimableAmountForPlan(address user, address token, uint256 planId) public view returns (uint256) {
		if (planId >= userVestingPlanCount[token][user]) return 0;
		return vestingPlans[token][user][planId].claimable();
	}

	/**
	 * @notice Get the unlocked token amount for a specific vesting plan.
	 * @param user   Address of the user.
	 * @param token  Address of the token.
	 * @param planId ID of the vesting plan.
	 * @return Total amount of tokens that have been unlocked in the plan.
	 */
	function getUnlockedAmountForPlan(address user, address token, uint256 planId) public view returns (uint256) {
		if (planId >= userVestingPlanCount[token][user]) return 0;
		return vestingPlans[token][user][planId].unlockedAmount();
	}

	/**
	 * @notice Get the total locked tokens for a user across all vesting plans for a token.
	 * @param user  Address of the user.
	 * @param token Address of the token.
	 * @return totalLocked Total amount of locked tokens across all plans.
	 */
	function getTotalLockedAmount(address user, address token) public view returns (uint256 totalLocked) {
		uint256 count = userVestingPlanCount[token][user];
		for (uint256 i = 0; i < count; i++) {
			totalLocked += getLockedAmountForPlan(user, token, i);
		}
	}

	/**
	 * @notice Get the total claimable tokens for a user across all vesting plans for a token.
	 * @param user  Address of the user.
	 * @param token Address of the token.
	 * @return totalClaimable Total amount of claimable tokens across all plans.
	 */
	function getTotalClaimableAmount(address user, address token) public view returns (uint256 totalClaimable) {
		uint256 count = userVestingPlanCount[token][user];
		for (uint256 i = 0; i < count; i++) {
			totalClaimable += getClaimableAmountForPlan(user, token, i);
		}
	}

	/**
	 * @notice Get the total unlocked tokens for a user across all vesting plans for a token.
	 * @param user  Address of the user.
	 * @param token Address of the token.
	 * @return totalUnlocked Total amount of unlocked tokens across all plans.
	 */
	function getTotalUnlockedAmount(address user, address token) public view returns (uint256 totalUnlocked) {
		uint256 count = userVestingPlanCount[token][user];
		for (uint256 i = 0; i < count; i++) {
			totalUnlocked += getUnlockedAmountForPlan(user, token, i);
		}
	}
}
