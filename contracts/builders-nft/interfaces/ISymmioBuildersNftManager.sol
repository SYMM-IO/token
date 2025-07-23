// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ISymmioBuildersNftManager {
	function completeUnlock(uint256 tokenId, uint256 amount) external;

	function cancelUnlock(uint256 tokenId, uint256 amount) external;
}
