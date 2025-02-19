// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./libraries/LibVestingPlan.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title Vesting Contract
contract Vesting is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20;
	using VestingPlanOps for VestingPlan;

	//--------------------------------------------------------------------------
	// Errors
	//--------------------------------------------------------------------------

	error MismatchArrays();
	error AlreadyClaimedMoreThanThis();
	error InvalidAmount();
	error ZeroAddress();

	//--------------------------------------------------------------------------
	// Events
	//--------------------------------------------------------------------------

	/// @notice Emitted when a vesting plan is set up.
	event VestingPlanSetup(address indexed token, address indexed user, uint256 amount, uint256 startTime, uint256 endTime);

	/// @notice Emitted when a vesting plan is reset.
	event VestingPlanReset(address indexed token, address indexed user, uint256 newAmount);

	/// @notice Emitted when unlocked tokens are claimed.
	event UnlockedTokenClaimed(address indexed token, address indexed user, uint256 amount);

	/// @notice Emitted when locked tokens are claimed.
	event LockedTokenClaimed(address indexed token, address indexed user, uint256 amount, uint256 penalty);

	//--------------------------------------------------------------------------
	// Roles
	//--------------------------------------------------------------------------

	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	//--------------------------------------------------------------------------
	// State Variables
	//--------------------------------------------------------------------------

	// Mapping: token => user => vesting plan
	mapping(address => mapping(address => VestingPlan)) public vestingPlans;

	uint256 public lockedClaimPenalty;
	address public lockedClaimPenaltyReceiver;

	/// @dev This reserved space is put in place to allow future versions to add new variables
	/// without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	//--------------------------------------------------------------------------
	// Initialization
	//--------------------------------------------------------------------------

	/// @notice Initializes the vesting contract.
	/// @param admin Address to receive the admin and role assignments.
	/// @param _lockedClaimPenalty Penalty rate (scaled by 1e18) for locked token claims.
	/// @param _lockedClaimPenaltyReceiver Address that receives the penalty.
	function __vesting_init(address admin, uint256 _lockedClaimPenalty, address _lockedClaimPenaltyReceiver) public initializer {
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		lockedClaimPenalty = _lockedClaimPenalty;
		lockedClaimPenaltyReceiver = _lockedClaimPenaltyReceiver;

		if (admin == address(0) || _lockedClaimPenaltyReceiver == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SETTER_ROLE, admin);
		_grantRole(PAUSER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);
		_grantRole(OPERATOR_ROLE, admin);
	}

	//--------------------------------------------------------------------------
	// Pausing / Unpausing
	//--------------------------------------------------------------------------

	/// @notice Pauses the contract, restricting state-changing functions.
	/// @dev Only accounts with PAUSER_ROLE can call this function.
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/// @notice Unpauses the contract, allowing state-changing functions.
	/// @dev Only accounts with UNPAUSER_ROLE can call this function.
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	//--------------------------------------------------------------------------
	// Vesting Plan Functions
	//--------------------------------------------------------------------------

	/// @notice Resets vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths or if any user's claimed amount exceeds the new amount.
	/// @param token Address of the token.
	/// @param users Array of user addresses.
	/// @param amounts Array of new token amounts.
	function resetVestingPlans(address token, address[] calldata users, uint256[] calldata amounts) external onlyRole(SETTER_ROLE) whenNotPaused {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 amount = amounts[i];
			// Claim any unlocked tokens before resetting.
			_claimUnlockedToken(token, user);
			VestingPlan storage vestingPlan = vestingPlans[token][user];
			if (amount < vestingPlan.unlockedAmount()) revert AlreadyClaimedMoreThanThis();
			vestingPlan.resetAmount(amount);
			emit VestingPlanReset(token, user, amount);
		}
	}

	/// @notice Sets up vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths.
	/// @param token Address of the token.
	/// @param startTime Vesting start time.
	/// @param endTime Vesting end time.
	/// @param users Array of user addresses.
	/// @param amounts Array of token amounts.
	function setupVestingPlans(
		address token,
		uint256 startTime,
		uint256 endTime,
		address[] calldata users,
		uint256[] calldata amounts
	) external onlyRole(SETTER_ROLE) whenNotPaused {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 amount = amounts[i];
			VestingPlan storage vestingPlan = vestingPlans[token][user];
			vestingPlan.setup(amount, startTime, endTime);
			emit VestingPlanSetup(token, user, amount, startTime, endTime);
		}
	}

	/// @notice Claims unlocked tokens for the caller.
	/// @param token Address of the token.
	function claimUnlockedToken(address token) external whenNotPaused {
		_claimUnlockedToken(token, msg.sender);
	}

	/// @notice Claims unlocked tokens for a specified user.
	/// @dev Only accounts with OPERATOR_ROLE can call this function.
	/// @param token Address of the token.
	/// @param user Address of the user.
	function claimUnlockedTokenFor(address token, address user) external onlyRole(OPERATOR_ROLE) whenNotPaused {
		_claimUnlockedToken(token, user);
	}

	/// @notice Claims locked tokens for the caller.
	/// @param token Address of the token.
	/// @param amount Amount of locked tokens to claim.
	function claimLockedToken(address token, uint256 amount) external whenNotPaused {
		_claimLockedToken(token, msg.sender, amount);
	}

	/// @notice Claims locked tokens for a specified user.
	/// @dev Only accounts with OPERATOR_ROLE can call this function.
	/// @param token Address of the token.
	/// @param user Address of the user.
	/// @param amount Amount of locked tokens to claim.
	function claimLockedTokenFor(address token, address user, uint256 amount) external onlyRole(OPERATOR_ROLE) whenNotPaused {
		_claimLockedToken(token, user, amount);
	}

	//--------------------------------------------------------------------------
	// Internal Functions
	//--------------------------------------------------------------------------

	/// @notice Internal function to claim unlocked tokens.
	/// @param token Address of the token.
	/// @param user Address of the user.
	function _claimUnlockedToken(address token, address user) internal nonReentrant {
		VestingPlan storage vestingPlan = vestingPlans[token][user];
		uint256 claimableAmount = vestingPlan.claimable();
		vestingPlan.claimedAmount += claimableAmount;
		IERC20(token).transfer(user, claimableAmount);
		emit UnlockedTokenClaimed(token, user, claimableAmount);
	}

	/// @notice Internal function to claim locked tokens.
	/// @param token Address of the token.
	/// @param user Address of the user.
	/// @param amount Amount of locked tokens to claim.
	function _claimLockedToken(address token, address user, uint256 amount) internal nonReentrant {
		// First, claim any unlocked tokens.
		_claimUnlockedToken(token, user);
		VestingPlan storage vestingPlan = vestingPlans[token][user];
		if (vestingPlan.lockedAmount() < amount) revert InvalidAmount();
		// Reset the vesting plan to reduce the locked amount.
		vestingPlan.resetAmount(vestingPlan.lockedAmount() - amount);
		uint256 penalty = (amount * lockedClaimPenalty) / 1e18;
		IERC20(token).transfer(user, amount - penalty);
		IERC20(token).transfer(lockedClaimPenaltyReceiver, penalty);
		emit LockedTokenClaimed(token, user, amount, penalty);
	}
}
