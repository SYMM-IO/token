// SPDX-License-Identifier: MIT

pragma solidity >=0.8.18;

interface ISymmStaking {
	function notifyRewardAmount(address[] calldata tokens, uint256[] calldata amounts) external;
}
