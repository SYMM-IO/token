// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { AccessControlEnumerable } from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

import { ISymmStaking } from "./ISymmStaking.sol";

/**
 * @title RewardNotifier
 * @notice This contract manages and distributes SYMM token rewards to a staking contract
 * @dev Non-upgradeable contract with role-based access control and pause functionality
 */
contract RewardNotifier is AccessControlEnumerable, Pausable {
	using SafeERC20 for IERC20;

	// ============ Constants ============

	/// @notice Role identifier for setting reward parameters
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role identifier for withdrawing funds
	bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

	/// @notice Role identifier for notifying rewards
	bytes32 public constant REWARD_NOTIFIER_ROLE = keccak256("REWARD_NOTIFIER_ROLE");

	/// @notice Role identifier for pausing the contract
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role identifier for unpausing the contract
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/// @notice Duration of one week in seconds
	uint256 public constant WEEK = 1 weeks;

	// ============ State Variables ============

	/// @notice SYMM token contract
	IERC20 public immutable symm;

	/// @notice Staking contract that receives reward notifications
	ISymmStaking public immutable staking;

	/// @notice Amount of SYMM tokens to distribute as rewards
	uint256 public rewardAmount;

	/// @notice Last reward round (week number) when rewards were distributed
	uint256 public lastRewardRound;

	// ============ Errors ============

	/// @notice Thrown when a zero address is provided
	error ZeroAddress();

	/// @notice Thrown when trying to pay rewards for a week that was already paid
	error RewardAlreadyPaid();

	/// @notice Thrown when reward amount is not set
	error RewardAmountNotSet();

	/// @notice Thrown when an invalid amount is provided
	error InvalidAmount();

	// ============ Events ============

	/// @notice Emitted when rewards are notified to the staking contract
	/// @param round The week number for which rewards were notified
	/// @param amount The amount of SYMM tokens distributed
	event RewardNotified(uint256 indexed round, uint256 amount);

	/// @notice Emitted when reward amount is updated
	/// @param oldAmount Previous reward amount
	/// @param newAmount New reward amount
	event RewardAmountSet(uint256 oldAmount, uint256 newAmount);

	/// @notice Emitted when funds are rescued from the contract
	/// @param token Address of the rescued token
	/// @param amount Amount of tokens rescued
	/// @param to Address that received the tokens
	event FundsRescued(address indexed token, uint256 amount, address indexed to);

	// ============ Constructor ============

	/**
	 * @notice Constructs the contract with required addresses
	 * @param _adminAddress Address that will have DEFAULT_ADMIN_ROLE
	 * @param _symmAddress Address of the SYMM token contract
	 * @param _stakingAddress Address of the staking contract
	 */
	constructor(address _adminAddress, address _symmAddress, address _stakingAddress) {
		if (_adminAddress == address(0) || _symmAddress == address(0) || _stakingAddress == address(0)) {
			revert ZeroAddress();
		}

		_grantRole(DEFAULT_ADMIN_ROLE, _adminAddress);
		staking = ISymmStaking(_stakingAddress);
		symm = IERC20(_symmAddress);
	}

	// ============ External Functions ============

	/**
	 * @notice Notifies the staking contract about available rewards
	 * @dev Can only be called by REWARD_NOTIFIER_ROLE, once per week, when not paused
	 * @dev Requires the contract to have sufficient SYMM balance
	 */
	function notifyReward() external onlyRole(REWARD_NOTIFIER_ROLE) whenNotPaused {
		uint256 currentRound = block.timestamp / WEEK;

		if (currentRound <= lastRewardRound) {
			revert RewardAlreadyPaid();
		}

		if (rewardAmount == 0) {
			revert RewardAmountNotSet();
		}

		// Approve staking contract to spend SYMM tokens
		symm.approve(address(staking), rewardAmount);

		// Prepare arrays for notifying rewards
		address[] memory tokens = new address[](1);
		tokens[0] = address(symm);

		uint256[] memory amounts = new uint256[](1);
		amounts[0] = rewardAmount;

		// Notify staking contract
		staking.notifyRewardAmount(tokens, amounts);

		// Update last reward round
		lastRewardRound = currentRound;

		emit RewardNotified(currentRound, rewardAmount);
	}

	/**
	 * @notice Sets the amount of SYMM tokens to distribute as rewards
	 * @dev Can only be called by SETTER_ROLE
	 * @param _amount New reward amount (must be greater than 0)
	 */
	function setRewardAmount(uint256 _amount) external onlyRole(SETTER_ROLE) {
		uint256 oldAmount = rewardAmount;
		rewardAmount = _amount;

		emit RewardAmountSet(oldAmount, _amount);
	}

	/**
	 * @notice Pauses the contract, preventing reward notifications
	 * @dev Can only be called by PAUSER_ROLE
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpauses the contract, allowing reward notifications
	 * @dev Can only be called by UNPAUSER_ROLE
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/**
	 * @notice Rescues tokens stuck in the contract
	 * @dev Can only be called by WITHDRAWER_ROLE
	 * @param token Address of the token to rescue
	 * @param amount Amount of tokens to rescue
	 */
	function rescueFunds(address token, uint256 amount) external onlyRole(WITHDRAWER_ROLE) {
		IERC20(token).safeTransfer(msg.sender, amount);

		emit FundsRescued(token, amount, msg.sender);
	}

	// ============ View Functions ============

	/**
	 * @notice Returns the current week number
	 * @return Current week number since Unix epoch
	 */
	function getCurrentRound() external view returns (uint256) {
		return block.timestamp / WEEK;
	}

	/**
	 * @notice Checks if rewards can be notified for the current week
	 * @return True if rewards haven't been paid for current week, false otherwise
	 */
	function canNotifyReward() external view returns (bool) {
		return (block.timestamp / WEEK > lastRewardRound) && (rewardAmount > 0) && !paused();
	}
}
