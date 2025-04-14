// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {IVesting} from "./interfaces/IVesting.sol";

contract SymmVestingRequester is AccessControlEnumerable, Pausable{

    error MismatchedArrays();
    error ZeroAmount();

    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

    uint256 public totalDays = 180 days;
    uint256 public penaltyPerDay = 25e16; // 0.25e15
    uint256 public launchDay;
    uint256 public totalRegisteredAmount = 0;
    uint256 public totalRegisteredUsers = 0;
    uint256 public totalVestedAmount = 0;
    mapping(address=>uint256) public registeredAmounts; // user => amount
    address public symmAddress;
    address public symmVestingAddress;

    constructor(address admin, address _symmAddress, address _symmVestingAddress){
        _grantRole(SETTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UNPAUSER_ROLE, admin);

        symmAddress = _symmAddress;
        symmVestingAddress = _symmVestingAddress;
        launchDay = (block.timestamp / 1 days) * 1 days;
    }

    function registerPlans(address[] memory users, uint256[] memory amounts) external onlyRole(SETTER_ROLE) { //TODO: whenNotPaused?
        if(users.length != amounts.length)
            revert MismatchedArrays();
        for(uint32 i=0; i<users.length; i++){
            if(registeredAmounts[users[i]] > amounts[i])
                totalRegisteredAmount -= registeredAmounts[users[i]] - amounts[i];
            else
                totalRegisteredAmount += amounts[i] - registeredAmounts[users[i]];
            if(registeredAmounts[users[i]]!=0) totalRegisteredUsers += 1;//TODO: How to check it's not already added? add them to a mapping?!
            registeredAmounts[users[i]] = amounts[i];
        }
    }

    function requestVestingPlan() external whenNotPaused{
        if(registeredAmounts[msg.sender] == 0) revert ZeroAmount();
        address[] memory users;
        uint256[] memory amounts;
        users[0] = msg.sender;
        amounts[0] = registeredAmounts[msg.sender];
        IVesting(symmVestingAddress).setupVestingPlans(
            symmAddress,
            block.timestamp,
            getEndTime(),
            users,
            amounts
        );
        totalVestedAmount += registeredAmounts[msg.sender];
        registeredAmounts[msg.sender] = 0;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }

    function getEndTime() public view returns(uint256){
        uint256 today = (block.timestamp / 1 days) * 1 days;
        uint256 daysPassed = today - launchDay;
        if(daysPassed > totalDays) daysPassed = totalDays;
        return today + totalDays - daysPassed + daysPassed * penaltyPerDay / 1e18;
    }
}
