// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRouter {
	function addLiquidityProportional(
		address pool,
		uint256[] memory maxAmountsIn,
		uint256 exactBptAmountOut,
		bool wethIsEth,
		bytes memory userData
	) external payable returns (uint256[] memory amountsIn);

	struct PermitApproval {
		address token;
		address owner;
		address spender;
		uint256 amount;
		uint256 nonce;
		uint256 deadline;
	}

	/// @notice The permit data for a token
	struct PermitDetails {
		// ERC20 token address
		address token;
		// the maximum amount allowed to spend
		uint160 amount;
		// timestamp at which a spender's token allowances become invalid
		uint48 expiration;
		// an incrementing value indexed per owner,token,and spender for each signature
		uint48 nonce;
	}

	/// @notice The permit message signed for multiple token allowances
	struct PermitBatch {
		// the permit data for multiple token allowances
		PermitDetails[] details;
		// address permissioned on the allowed tokens
		address spender;
		// deadline on the permit signature
		uint256 sigDeadline;
	}

	/**
	 * @notice Permits multiple allowances and executes a batch of function calls on this contract.
	 * @param permitBatch An array of `PermitApproval` structs, each representing an ERC20 permit request
	 * @param permitSignatures An array of bytes, corresponding to the permit request signature in `permitBatch`
	 * @param permit2Batch A batch of permit2 approvals
	 * @param permit2Signature A permit2 signature for the batch approval
	 * @param multicallData An array of bytes arrays, each representing an encoded function call on this contract
	 * @return results Array of bytes arrays, each representing the return data from each function call executed
	 */
	function permitBatchAndCall(
		PermitApproval[] calldata permitBatch,
		bytes[] calldata permitSignatures,
		PermitBatch calldata permit2Batch,
		bytes calldata permit2Signature,
		bytes[] calldata multicallData
	) external payable returns (bytes[] memory results);
}
