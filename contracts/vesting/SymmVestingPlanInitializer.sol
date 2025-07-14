// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import { IVesting } from "./interfaces/IVesting.sol";

/**
 * @title SymmVestingPlanInitializer
 * @notice Allows SYMM holders to initialize their individual vesting plans after launch.
 *         A penalty is applied that increases linearly for every day elapsed after launch.
 */
contract SymmVestingPlanInitializer is AccessControlEnumerable, Pausable {
	// =============================================================
	//                            ERRORS
	// =============================================================

	error MismatchedArrays();
	error ZeroAmount();
	error ExceededMaxSymmAmount(uint256 exceededAmount, uint256 maxAllowed);

	// =============================================================
	//                             ROLES
	// =============================================================

	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	// =============================================================
	//                           CONSTANTS
	// =============================================================

	uint256 public constant VESTING_DURATION = 140 days;
	uint256 public constant PENALTY_PER_DAY_BP = 1e17; // 1% expressed as 0.1 * 1e18

	// =============================================================
	//                           IMMUTABLES
	// =============================================================

	uint256 public immutable launchDay;
	uint256 public immutable maxVestedSYMM;
	address public immutable SYMM;
	address public immutable vesting;

	// =============================================================
	//                            STORAGE
	// =============================================================

	uint256 public pendingTotal; // Total amount yet to be initiated
	mapping(address => uint256) public pendingAmount; // Amount a user can still initiate
	mapping(address => uint256) public vestedAmount; // Amount a user has already vested

	// =============================================================
	//                          CONSTRUCTOR
	// =============================================================

	constructor(address admin, address _symm, address _vesting, uint256 _maxVestedSYMM, uint256 _launchTimestamp) {
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SETTER_ROLE, admin);
		_grantRole(PAUSER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);

		SYMM = _symm;
		vesting = _vesting;
		launchDay = (_launchTimestamp / 1 days) * 1 days;
		maxVestedSYMM = _maxVestedSYMM;
	}

	// =============================================================
	//                       ADMIN FUNCTIONS
	// =============================================================

	/**
	 * @notice Sets the vestable amounts for a list of users.
	 * @dev Callable only by addresses with SETTER_ROLE.
	 */
	function setPendingAmounts(address[] calldata users, uint256[] calldata amounts) external onlyRole(SETTER_ROLE) {
		if (users.length != amounts.length) revert MismatchedArrays();

		for (uint256 i; i < users.length; ++i) {
			pendingTotal = pendingTotal + amounts[i] - pendingAmount[users[i]];
			if (pendingTotal > maxVestedSYMM) revert ExceededMaxSymmAmount(pendingTotal, maxVestedSYMM);

			pendingAmount[users[i]] = amounts[i];
		}
	}

	// =============================================================
	//                       USER FUNCTIONS
	// =============================================================

	/**
	 * @notice Starts the vesting plan for the caller.
	 * @dev Reverts if nothing to vest. Applies penalty based on delay.
	 */
	function startVesting() external whenNotPaused {
		uint256 amount = pendingAmount[msg.sender];
		if (amount == 0) revert ZeroAmount();

		address[] memory users = new address[](1);
		uint256[] memory amounts = new uint256[](1);
		users[0] = msg.sender;
		amounts[0] = amount;

		IVesting(vesting).setupVestingPlans(SYMM, block.timestamp, _endTime(block.timestamp), users, amounts);

		vestedAmount[msg.sender] += amount;
		pendingAmount[msg.sender] = 0;
	}

	// =============================================================
	//                       PAUSE FUNCTIONS
	// =============================================================

	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	// =============================================================
	//                       VIEW FUNCTIONS
	// =============================================================

	/**
   * @notice Calculates the end time for new vesting schedules.
   * @dev Launch day has weight 0 penalty, full duration. Each day after increases duration linearly.
   */
	function endTimeStartsAt(uint256 _timestamp) external view returns (uint256) {
		return _endTime(_timestamp);
	}

	/**
     * @notice Calculates the end time for new vesting schedules.
   * @dev Launch day has weight 0 penalty, full duration. Each day after increases duration linearly.
   */
	function endTime() external view returns (uint256) {
		return _endTime(block.timestamp);
	}

	function _endTime(uint256 _timestamp) internal view returns (uint256) {
		if(_timestamp >= VESTING_DURATION + launchDay){
			return _timestamp + 14 days;
		}
		uint256 today = (_timestamp / 1 days) * 1 days;
		uint256 daysElapsed = today - launchDay;

		// Penalty scales linearly: for each day, add PENALTY_PER_DAY_BP bp (1e18 = 100%)
		uint256 penalty = (daysElapsed * PENALTY_PER_DAY_BP) / 1e18;
		uint256 et = VESTING_DURATION + launchDay + penalty;
		return et;
	}
}
