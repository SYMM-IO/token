// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/**
 * @notice State for a single linear vesting schedule.
 * @param owner Beneficiary entitled to claim from the flow.
 * @param amount Amount represented by the current flow segment.
 * @param startTime Timestamp at which the current segment starts vesting.
 * @param endTime Timestamp at which the remaining amount is fully vested.
 */
struct Flow {
	address owner;
	uint256 amount;
	uint256 startTime;
	uint256 endTime;
}

/// @notice Helpers for calculating and mutating linear vesting flows.
library VestingFlowLib {
	/// @notice Raised when locked principal is decreased without first shrinking the flow.
	error FlowNotShrunk();

	/// @notice Raised when a requested decrease exceeds the flow's remaining amount.
	error InsufficientLockedAmount();

	/// @notice Calculates the amount vested in the current flow segment.
	/// @param self Flow to inspect.
	/// @return Amount vested between `startTime` and the current timestamp.
	function unlocked(Flow storage self) internal view returns (uint256) {
		if (self.amount == 0) return 0;
		uint256 ts = block.timestamp;
		if (ts <= self.startTime) return 0;
		if (ts >= self.endTime) return self.amount;
		return (self.amount * (ts - self.startTime)) / (self.endTime - self.startTime);
	}

	/**
	 * @notice Advances a flow to the current timestamp after its vested amount is accounted for.
	 * @param self Flow to advance.
	 * @return cleared Whether the flow reached its end and was deleted.
	 * @dev Returns without mutation before or at the start time. Clears a fully
	 *      vested flow; otherwise moves its start time to the current timestamp.
	 */
	function shrink(Flow storage self) internal returns (bool cleared) {
		uint256 ts = block.timestamp;
		if (ts <= self.startTime) return false;
		if (ts >= self.endTime) {
			clear(self);
			return true;
		}
		self.startTime = ts;
		self.amount -= unlocked(self);
		return false;
	}

	/**
	 * @notice Removes unvested principal from a flow that was advanced this block.
	 * @param self Flow to reduce.
	 * @param amount Amount of unvested principal to remove.
	 * @return cleared Whether removing the amount cleared the flow.
	 */
	function decreaseLockedAmount(Flow storage self, uint256 amount) internal returns (bool cleared) {
		if (self.startTime < block.timestamp) revert FlowNotShrunk();
		uint256 lockedAmount = self.amount;
		if (amount > lockedAmount) revert InsufficientLockedAmount();
		if (amount == lockedAmount) {
			clear(self);
			return true;
		}
		self.amount = lockedAmount - amount;
		return false;
	}

	/// @notice Deletes all state belonging to a flow.
	/// @param self Flow to clear.
	function clear(Flow storage self) internal {
		delete self.owner;
		delete self.amount;
		delete self.startTime;
		delete self.endTime;
	}
}
