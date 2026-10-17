// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SymmioBuildersNftManager } from "../builders-nft/SymmioBuildersNftManager.sol";

/// @notice Contract builder used to exercise failed and reentrant pledge releases.
contract MockNftPledgeOwner is IERC721Receiver {
	SymmioBuildersNftManager public immutable manager;
	IERC721 public immutable nft;
	bool public rejectTransfers;
	bytes public reentryData;
	bool public reentrySucceeded;
	bytes public reentryResult;

	constructor(address manager_, address nft_) {
		manager = SymmioBuildersNftManager(manager_);
		nft = IERC721(nft_);
	}

	function pledge(uint256 tokenId) external {
		nft.approve(address(manager), tokenId);
		manager.lockNftAsPledge(tokenId);
	}

	function setRejectTransfers(bool reject) external {
		rejectTransfers = reject;
	}

	function setReentryData(bytes calldata data) external {
		reentryData = data;
	}

	function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
		require(!rejectTransfers, "NFT rejected");
		if (reentryData.length > 0) (reentrySucceeded, reentryResult) = address(manager).call(reentryData);
		return IERC721Receiver.onERC721Received.selector;
	}
}
