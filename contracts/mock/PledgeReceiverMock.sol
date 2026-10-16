// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @dev Test-only recipient/controller, including rejection and reentrancy.
contract PledgeReceiverMock is IERC721Receiver {
	bool public reject;
	address public reentryTarget;
	bytes public data;
	bytes public reentryResult;
	bool public reentrySucceeded;
	function configure(bool reject_, address target_, bytes calldata data_) external {
		reject = reject_;
		reentryTarget = target_;
		data = data_;
	}
	function execute(address target_, bytes calldata data_) external {
		(bool success, bytes memory result) = target_.call(data_);
		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}
	}
	function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
		require(!reject, "Receiver rejects NFT");
		if (reentryTarget != address(0)) {
			(reentrySucceeded, reentryResult) = reentryTarget.call(data);
		}
		return IERC721Receiver.onERC721Received.selector;
	}
}
