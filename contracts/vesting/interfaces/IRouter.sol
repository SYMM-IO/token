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

}
