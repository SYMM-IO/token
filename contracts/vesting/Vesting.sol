// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "../token/symm.sol";
import "./LiquidityHandler.sol";

contract Vesting is Initializable, AccessControlEnumerableUpgradeable, LiquidityHandler{
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    mapping (address => uint256) public tokenAmounts;
    mapping (address => uint256) public claimedAmounts;
    mapping (address => uint256) public symmLPOut;

    uint256 public totalTime;
    uint256 public startTime;
    address public symmAddress;

    function initialize(address admin, uint256 _totalTime, uint256 _startTime, address _symmTime) public initializer{
        __AccessControlEnumerable_init();
        require(block.timestamp >= startTime, "Start time should be grater or equal to now");
        totalTime = _totalTime;
        startTime = _startTime;
        symmAddress = _symmTime;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin); //Check: should they be different
    }

    function setTokenAmount(address user, uint256 amount) external onlyRole(ADMIN_ROLE){
        require(amount >= claimedAmounts[user], "Requested amount exceeds claimed amount of the user");
        tokenAmounts[user] = amount;
    }

    function claim(uint256 amount) external{
        _claim(amount, msg.sender);
    }

    function claimFor(uint256 amount, address user) external onlyRole(ADMIN_ROLE){ //Check should we have some amount that can be freed without time
        _claim(amount, user);
    }


    function setPoolAddress(address _poolAddress) external onlyRole(ADMIN_ROLE){
        _setPoolAddress(_poolAddress);
        //Check event?
    }

    function setRouterAddress(address _routerAddress) external onlyRole(ADMIN_ROLE){
        _setRouterAddress(_routerAddress);
        //Check event?
    }

    function _claim(uint256 amount, address user) internal { //Check should we have some amount that can be freed without time
        uint256 availableAmount = getClaimableAmount(user);
        require(availableAmount >= amount, "Requested amount exceeds available amount possible to claim");
        claimedAmounts[user] += amount; //Check the compiler version should avoid O.F.
        //FIX: mint or transfer
        Symmio(symmAddress).mint(user, amount);
    }

    function getClaimableAmount(address user) public view returns(uint256){
        uint256 endTime = block.timestamp;
        if(endTime > startTime + totalTime)
            endTime = startTime + totalTime;
        uint256 availableAmount =
            (
                (tokenAmounts[user] * 1e18 / totalTime) *
                (endTime - startTime)
            ) / 1e18;
        if (availableAmount >= claimedAmounts[user])
            availableAmount -= claimedAmounts[user];
        return availableAmount;
    }

}

