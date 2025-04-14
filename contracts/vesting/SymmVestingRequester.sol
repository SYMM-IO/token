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

    uint256 public constant TOTAL_DAYS = 180 days;
    uint256 public constant PENALTY_PER_DAY = 25e16; // 0.25e15

    uint256 public immutable launchDay;
    uint256 public immutable maxSymmAmount;
    address public immutable symmAddress;
    address public immutable symmVestingAddress;

    uint256 public initiatableAmountsSum = 0;
    uint256 public usersInitiatedCount = 0;
    uint256 public totalVestedAmount = 0; //TODO: totalInitiatedAmount?
    mapping(address=>uint256) public initiatableAmount; // user => amount //TODO: Can be renamed to pendingVestingPlan

    constructor(address admin, address _symmAddress, address _symmVestingAddress, uint256 _totalInitiatableSYMM){
        _grantRole(SETTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UNPAUSER_ROLE, admin);

        symmAddress = _symmAddress;
        symmVestingAddress = _symmVestingAddress;
        launchDay = (block.timestamp / 1 days) * 1 days;
        maxSymmAmount = _totalInitiatableSYMM;
    }

    function setInitiatableVestingAmount(address[] memory users, uint256[] memory amounts) external onlyRole(SETTER_ROLE) { //TODO: whenNotPaused?
        if(users.length != amounts.length)
            revert MismatchedArrays();
        for(uint32 i=0; i<users.length; i++){
            if(initiatableAmount[users[i]] > amounts[i])
                initiatableAmountsSum -= initiatableAmount[users[i]] - amounts[i];
            else
                initiatableAmountsSum += amounts[i] - initiatableAmount[users[i]];
            if(initiatableAmount[users[i]]!=0) usersInitiatedCount += 1;//TODO: How to check it's not already added? add them to a mapping?!
            initiatableAmount[users[i]] = amounts[i];
        }
    }

    function initiateVestingPlan() external whenNotPaused {
        if(initiatableAmount[msg.sender] == 0) revert ZeroAmount();
        address[] memory users;
        uint256[] memory amounts;
        users[0] = msg.sender;
        amounts[0] = initiatableAmount[msg.sender];
        IVesting(symmVestingAddress).setupVestingPlans(
            symmAddress,
            block.timestamp,
            getEndTime(),
            users,
            amounts
        );
        totalVestedAmount += initiatableAmount[msg.sender];
        if(totalVestedAmount > maxSymmAmount)
        initiatableAmount[msg.sender] = 0;
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
        if(daysPassed > TOTAL_DAYS) daysPassed = TOTAL_DAYS;
        return today + TOTAL_DAYS - daysPassed + daysPassed * PENALTY_PER_DAY / 1e18;
    }
}
