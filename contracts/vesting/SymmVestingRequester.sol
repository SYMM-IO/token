// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import {IVesting} from "./interfaces/IVesting.sol";

contract SymmVestingRequester {

    error MismatchedArrays();
    error ZeroAmount();

    //init

    uint256 public totalTime = 180 days;
    uint256 public penaltyPerDay = 25e16;
    uint256 public launchTime;
    uint256 public totalRegisteredAmount = 0;
    uint256 public totalRegisteredUsers = 0;
    uint256 public totalVestedAmount = 0;
    mapping(address=>uint256) public registeredAmounts; // user => amount
    address public symmAddress;
    address public symmVestingAddress;

    function registerPlans(address[] memory users, uint256[] memory amounts) external {//onlyRole
        if(users.length != amounts.length)
            revert MismatchedArrays();
        for(uint32 i=0; i<users.length; i++){
            if(registeredAmounts[users[i]] > amounts[i])
                totalRegisteredAmount -= registeredAmounts[users[i]] - amounts[i];
            else
                totalRegisteredAmount += amounts[i] - registeredAmounts[users[i]];
            if(registeredAmounts[users[i]]!=0) totalRegisteredUsers += 1;//TODO: How to check it's not already added?
            registeredAmounts[users[i]] = amounts[i];
        }
    }

    function requestVestingPlan() external {
        if(registeredAmounts[msg.sender] == 0) revert ZeroAmount();
        address[] memory users;
        uint256[] memory amounts;
        users[0] = msg.sender;
        amounts[0] = registeredAmounts[msg.sender];
        IVesting(symmVestingAddress).setupVestingPlans(
            symmAddress,
            block.timestamp,
            _getEndTime(),
            users,
            amounts
        );
        totalVestedAmount += registeredAmounts[msg.sender];
        registeredAmounts[msg.sender] = 0;
    }

    function _getEndTime() private view returns(uint256){
        uint256 timePassed = (block.timestamp / 1days - launchTime / 1days) * 1days;
        if(timePassed > totalTime) timePassed = totalTime;
        return block.timestamp + totalTime - timePassed + timePassed * penaltyPerDay / 1e18;
    }
}
