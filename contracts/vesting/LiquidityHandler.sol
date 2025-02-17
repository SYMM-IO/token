// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./interfaces/IPool.sol";
import "./interfaces/IRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LiquidityHandler{
    //TODO: consider that as a contract this would be where symm and usdc tokens are here.
    address public poolAddress;
    address public BPRouterAddress;
    address public BPVaultAddress; //TODO: hardCode

    function _setPoolAddress(address _poolAddress) internal{
        poolAddress = _poolAddress;
    }

    function _setRouterAddress(address _routerAddress) internal{
        BPRouterAddress = _routerAddress;
    }

    function _addLiquidity(uint256 symmIn) internal returns(uint256[] memory, uint256){
        (uint256 usdcIn, uint256 BPTAmountOut) = quoteUSDC_BPT(symmIn);
        IERC20[] memory poolTokens = IPool(poolAddress).getTokens();
        (IERC20 symm, IERC20 usdc) = (poolTokens[0], poolTokens[1]);
        usdc.transferFrom(msg.sender, address(this), usdcIn); //Check from and to
        usdc.approve(BPVaultAddress, usdcIn);
        symm.approve(BPVaultAddress, symmIn);
        uint256[] memory amountsIn = new uint256[](2);
        amountsIn[0] = symmIn;
        amountsIn[1] =  usdcIn;
        return (IRouter(BPRouterAddress).addLiquidityProportional(
            poolAddress,
            amountsIn,
            BPTAmountOut,
            false, //wethIsEth: bool
            "" //userData: bytes
        ), BPTAmountOut);
    }

    //TODO: better ui
    function quoteUSDC_BPT(uint256 symmAmount) public view returns(uint256, uint256){
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
