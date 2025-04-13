// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IVesting} from "./interfaces/IVesting.sol";

contract SymmVestingRequester is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable {

    error MismatchedArrays();
    error ZeroAmount();

    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

    uint256 public totalTime = 180 days;
    uint256 public penaltyPerDay = 25e16; // 0.25e15
    uint256 public launchTime;
    uint256 public totalRegisteredAmount = 0;
    uint256 public totalRegisteredUsers = 0;
    uint256 public totalVestedAmount = 0;
    mapping(address=>uint256) public registeredAmounts; // user => amount
    address public symmAddress;
    address public symmVestingAddress;

    function initializer(address admin, address _symmAddress, address _symmVestingAddress) public initializer{
        __AccessControlEnumerable_init();
        __Pausable_init();

        _grantRole(SETTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UNPAUSER_ROLE, admin);

        symmAddress = _symmAddress;
        symmVestingAddress = _symmVestingAddress;
        launchTime = block.timestamp;
    }

    function registerPlans(address[] memory users, uint256[] memory amounts) external onlyRole(SETTER_ROLE) { //TODO: whenNotPaused?
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

    function requestVestingPlan() external whenNotPaused{
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

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }

    function _getEndTime() private view returns(uint256){
        uint256 timePassed = (block.timestamp / 1days - launchTime / 1days) * 1days;
        if(timePassed > totalTime) timePassed = totalTime;
        return block.timestamp + totalTime - timePassed + timePassed * penaltyPerDay / 1e18;
    }
}
