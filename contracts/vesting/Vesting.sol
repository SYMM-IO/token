// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../token/symm.sol";

contract Vesting is Ownable{
    mapping (address => uint256) public tokenAmounts;
    mapping (address => uint256) public claimedAmounts;

    uint256 public TOTAL_TIME;
    uint256 public START_TIME;
    address public SYMM_ADDRESS;

    constructor(uint256 _TOTAL_TIME, uint256 _START_TIME, address _SYMM_ADDRESS, address owner) Ownable(owner){
        require(block.timestamp >= START_TIME, "Start time should be grater or equal to now");
        TOTAL_TIME = _TOTAL_TIME;
        START_TIME = _START_TIME;
        SYMM_ADDRESS = _SYMM_ADDRESS;
    }


    function setTokenAmount(address user, uint256 amount) external onlyOwner{
        require(amount >= claimedAmounts[user], "Requested amount exceeds claimed amount of the user");
        tokenAmounts[user] = amount;
    }

    function claim(uint256 amount) external{
        uint256 availableAmount = getAvailableAmount(msg.sender);//check there are some remained tokens, consider adding a method for paying all remaining tokens
        require(availableAmount >= amount, "Requested amount exceeds available amount possible to claim");
        claimedAmounts[msg.sender] += amount; //Check the compiler version should avoid O.F.
        //FIX: mint or transfer
        Symmio(SYMM_ADDRESS).mint(msg.sender, amount);
    }

    function claimFor(uint256 amount, address user) external onlyOwner{ //Check should we have some amount that can be freed without time
        uint256 availableAmount = getAvailableAmount(user);
        require(availableAmount >= amount, "Requested amount exceeds available amount possible to claim");
        claimedAmounts[user] += amount; //Check the compiler version should avoid O.F.
        //FIX: mint or transfer
        Symmio(SYMM_ADDRESS).mint(user, amount);
    }

    function getAvailableAmount(address user) public view returns(uint256){
        uint256 endTime = block.timestamp;
        if(endTime > START_TIME + TOTAL_TIME)
            endTime = START_TIME + TOTAL_TIME;
        uint256 availableAmount =
            (
                (tokenAmounts[user] * 1e18 / TOTAL_TIME) *
                (endTime - START_TIME)
            ) / 1e18;
        if (availableAmount >= claimedAmounts[user])
            availableAmount -= claimedAmounts[user];
        return availableAmount;
    }
}

