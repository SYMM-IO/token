// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IPool {
    /**
     * @notice Gets the current live balances of the pool as fixed point, 18-decimal numbers.
     * @dev Note that live balances will not necessarily be accurate if the pool is in Recovery Mode.
     * Withdrawals in Recovery Mode do not make external calls (including those necessary for updating live balances),
     * so if there are withdrawals, raw and live balances will be out of sync until Recovery Mode is disabled.
     *
     * @return balancesLiveScaled18 Token balances after paying yield fees, applying decimal scaling and rates
     */
    function getCurrentLiveBalances() external view returns (uint256[] memory balancesLiveScaled18);

    function queryAddLiquidityProportional(
        address pool,
        uint256 exactBptAmountOut,
        address sender,
        bytes memory userData
    ) external returns (uint256[] memory amountsIn);

    function addLiquidityProportional(
        address pool,
        uint256[] memory maxAmountsIn,
        uint256 exactBptAmountOut,
        bool wethIsEth,
        bytes memory userData
    ) external payable returns (uint256[] memory amountsIn);

    function queryAddLiquidityUnbalanced(
        address pool,
        uint256[] memory exactAmountsIn,
        address sender,
        bytes memory userData
    ) external returns (uint256 bptAmountOut);
}
