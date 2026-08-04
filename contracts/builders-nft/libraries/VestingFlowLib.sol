// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

struct Flow {
	address owner;
	uint256 amount;
	uint256 startTime;
	uint256 endTime;
}

library VestingFlowLib {
	error FlowNotShrunk();
	error InsufficientLockedAmount();

	/// @notice Total amount that has been unlocked (claimable).
	function unlocked(Flow storage self) internal view returns (uint256) {
		if (self.amount == 0) return 0;
		uint256 ts = block.timestamp;
		if (ts <= self.startTime) return 0;
		if (ts >= self.endTime) return self.amount;
		return (self.amount * (ts - self.startTime)) / (self.endTime - self.startTime);
	}

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

	function clear(Flow storage self) internal {
		delete self.owner;
		delete self.amount;
		delete self.startTime;
		delete self.endTime;
	}
}
