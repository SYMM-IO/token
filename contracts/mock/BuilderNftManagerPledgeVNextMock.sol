// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import { SymmioBuildersNftManager } from "../builders-nft/SymmioBuildersNftManager.sol";
/// @dev Test-only compatible upgrade, without storage or initializer changes.
contract BuilderNftManagerPledgeVNextMock is SymmioBuildersNftManager {
	function pledgeImplementationVersion() external pure returns (uint256) {
		return 2;
	}
}
