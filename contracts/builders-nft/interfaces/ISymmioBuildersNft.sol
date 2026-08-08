// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Interface used by the manager to mint, burn, and maintain builder NFT lock data.
interface ISymmioBuildersNft is IERC721 {
	/**
	 * @notice Comprehensive lock data structure for each NFT.
	 * @param amount           Total amount of SYMM tokens represented by the NFT.
	 * @param lockTimestamp    Timestamp when the tokens were locked.
	 * @param unlockingAmount  Amount of tokens currently being unlocked.
	 * @param name             Brand name associated with the NFT.
	 */
	struct LockData {
		uint256 amount;
		uint256 lockTimestamp;
		uint256 unlockingAmount;
		string name;
	}

	/// @notice Mints an NFT and initializes its lock data.
	/// @param to Address receiving the NFT.
	/// @param amount Initial total locked amount represented by the NFT.
	/// @param name Brand name associated with the NFT.
	/// @return tokenId ID of the newly minted NFT.
	/// @dev Implementations are expected to restrict this function to authorized minters.
	function mint(address to, uint256 amount, string memory name) external returns (uint256 tokenId);

	/// @notice Burns an NFT and removes its lock data.
	/// @param tokenId ID of the NFT to burn.
	/// @dev Implementations are expected to restrict this function to authorized burners.
	function burn(uint256 tokenId) external;

	/// @notice Returns the complete lock data for an existing NFT.
	/// @param tokenId ID of the NFT to query.
	/// @return Stored lock data for `tokenId`.
	function getLockData(uint256 tokenId) external view returns (LockData memory);

	/// @notice Replaces the mutable lock data for an existing NFT.
	/// @param tokenId ID of the NFT to update.
	/// @param amount New total locked amount represented by the NFT.
	/// @param unlockingAmount Portion assigned to active unlock requests.
	/// @param name New brand name associated with the NFT.
	/// @dev Implementations are expected to restrict this function to the manager or an equivalent trusted role.
	function updateLockData(uint256 tokenId, uint256 amount, uint256 unlockingAmount, string memory name) external;

	/// @notice Pauses NFT minting, burning, lock-data updates, and transfers.
	function pause() external;

	/// @notice Resumes NFT operations disabled by the system pause.
	function unpause() external;

	/// @notice Returns whether the NFT is globally paused.
	/// @return Whether the NFT is paused.
	function paused() external view returns (bool);
}
