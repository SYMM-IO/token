// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IPool.sol";

contract LiquidityHandler is Initializable, IPool{

    address public poolAddress;

    function initialize() public initializer{

    }

    function setPoolAddress(address _poolAddress) external onlyRole(ADMIN_ROLE){
        poolAddress = _poolAddress;
    }

    function addLiquidity(uint256[] memory amountsIn) internal returns(uint256){
        uint256[] memory bptAmountOut =  queryAddLiquidityUnbalanced(
            poolAddress,
            amountsIn,
            "0x0",
            "0x0"
        );
    return addLiquidityProportional(
        poolAddress,
        amountsIn,
        bptAmountOut,
        "0x0",
        "0x0"
    );
    }

    function quoteUSDC(uint256 symmAmount) public view returns(uint256){
        uint256[] memory balancesLiveScaled18 = IPool(poolAddress).getCurrentLiveBalances();
        uint256 symmReserve = balancesLiveScaled18[0];
        uint256 usdcReserve = balancesLiveScaled18[1];
        return ((usdcReserve * 1e18 / symmReserve) * (8/2) * symmAmount) / 1e18;
    }
}
