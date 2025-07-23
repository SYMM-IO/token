// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ISymmBuildersNftUnlockManager {
	function initiateUnlock(uint256 tokenId, address owner, uint256 amount) external;

	function isUnlocking(uint256 tokenId) external view returns (bool);
}
