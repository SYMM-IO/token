// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface ISymmioBuildersNft is IERC721 {
	/**
	 * @notice Comprehensive lock data structure for each NFT.
	 * @param amount           Total amount of SYMM tokens locked.
	 * @param lockTimestamp    Timestamp when the tokens were locked.
	 * @param unlockingAmount  Amount of tokens currently being unlocked.
	 */
	struct LockData {
		uint256 amount;
		uint256 lockTimestamp;
		uint256 unlockingAmount;
		string name;
	}

	function mint(address to, uint256 amount, string memory name) external returns (uint256 tokenId);

	function burn(uint256 tokenId) external;

	function getLockData(uint256 tokenId) external view returns (LockData memory);

	function updateLockData(uint256 tokenId, uint256 amount, uint256 unlockingAmount, string memory name) external;
}
