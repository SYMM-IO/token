// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IRouter.sol";

contract LiquidityHandler is Initializable{

    address public poolAddress;
    address public routerAddress;

    function initialize() public initializer{

    }

    function _setPoolAddress(address _poolAddress) internal{
        poolAddress = _poolAddress;
    }

    function _setRouterAddress(address _routerAddress) internal{
        routerAddress = _routerAddress;
    }

    function _addLiquidity(uint256 symmIn) internal returns(uint256[] memory){
        (uint256 usdcIn, uint256 BPTAmountOut) = quoteUSDC_BPT(symmIn);
        uint256[] memory amountsIn = new uint256[](2);
        amountsIn[0] = symmIn;
        amountsIn[1] =  usdcIn;
        return IRouter(routerAddress).addLiquidityProportional(
            poolAddress,
            amountsIn,
            BPTAmountOut,
            false, //wethIsEth: bool
            "" //userData: bytes
        );
    }

    function quoteUSDC_BPT(uint256 symmAmount) public view returns(uint256, uint256){ //Check: 1. should the name include usdc? 2. Is this good as a view method or we should have a separate one for usdc(approve)
        uint256[] memory balancesLiveScaled18 = IPool(poolAddress).getCurrentLiveBalances();
        uint256 bptBalance = IPool(poolAddress).totalSupply();
        uint256 symmBalance = balancesLiveScaled18[0];
        uint256 usdcBalance = balancesLiveScaled18[1];
        uint256 ratioScaled18 = symmAmount * 1e18 / symmBalance; //Check: check if should be scaled or not
        uint256 USDCAmount = ratioScaled18 * usdcBalance / 1e18;
        uint256 BPTAmount = ratioScaled18 * bptBalance / 1e18;
        return (USDCAmount, BPTAmount);
    }
}
