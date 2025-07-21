// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "./interfaces/IVesting.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

interface ISymmVestingPlanInitializer {
	function endTimeStartsAt(uint256 _timestamp) external view returns (uint256);
}

contract VestingUpsertManager is Initializable, AccessControlEnumerableUpgradeable {
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	IVesting public vesting;
	ISymmVestingPlanInitializer public planInitializer;

	function initialize(address admin, address operator, address vestingAddress, address vestingPlanAddress) public initializer {
		__AccessControlEnumerable_init();
		vesting = IVesting(vestingAddress);
		planInitializer = ISymmVestingPlanInitializer(vestingPlanAddress);
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(OPERATOR_ROLE, operator);
	}

	function upsertVestingPlans(address token, address[] calldata users, uint256[] calldata newAmounts) external onlyRole(OPERATOR_ROLE) {
		require(users.length == newAmounts.length, "VestingUpsertManager: Mismatched lengths");
		require(token != address(0), "VestingUpsertManager: Zero address");

		uint256 startTime = block.timestamp;
		uint256 endTime = planInitializer.endTimeStartsAt(startTime);

		address[] memory toSetup = new address[](users.length);
		uint256[] memory toSetupAmounts = new uint256[](users.length);
		uint256 setupCount = 0;

		address[] memory toReset = new address[](users.length);
		uint256[] memory toResetAmounts = new uint256[](users.length);
		uint256 resetCount = 0;

		for (uint256 i = 0; i < users.length; i++) {
			(uint256 existingAmount, , , ) = vesting.vestingPlans(token, users[i]);

			if (existingAmount == 0) {
				toSetup[setupCount] = users[i];
				toSetupAmounts[setupCount] = newAmounts[i];
				setupCount++;
			} else {
				uint256 locked = vesting.getLockedAmountsForToken(token, users[i]);
				toReset[resetCount] = users[i];
				toResetAmounts[resetCount] = locked + newAmounts[i];
				resetCount++;
			}
		}

		if (setupCount > 0) vesting.setupVestingPlans(token, startTime, endTime, _slice(toSetup, setupCount), _slice(toSetupAmounts, setupCount));
		if (resetCount > 0) vesting.resetVestingPlans(token, _slice(toReset, resetCount), _slice(toResetAmounts, resetCount));
	}

	function _slice(address[] memory input, uint256 length) internal pure returns (address[] memory) {
		address[] memory output = new address[](length);
		for (uint256 i = 0; i < length; i++) output[i] = input[i];
		return output;
	}

	function _slice(uint256[] memory input, uint256 length) internal pure returns (uint256[] memory) {
		uint256[] memory output = new uint256[](length);
		for (uint256 i = 0; i < length; i++) output[i] = input[i];
		return output;
	}
}
