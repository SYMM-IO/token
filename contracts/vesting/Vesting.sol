// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../token/symm.sol";
import "./LiquidityHandler.sol";

contract Vesting is Initializable, AccessControlEnumerableUpgradeable, LiquidityHandler{
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct VestingPlan{
        uint256 startTime;
        uint256 totalTime;
        uint256 totalAmount;
        uint256 claimedAmount;
        address token;
    }

    mapping (address => VestingPlan) public symmVestingPlans;
    mapping (address => VestingPlan) public LPVestingPlans;

    address public feeCollector;

    function initialize(address admin) public initializer{
        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function setSymmTokenAmount(address user, uint256 amount) external onlyRole(ADMIN_ROLE){
        VestingPlan memory vestingPlan = symmVestingPlans[user];
        require(amount >= _getTotalUnlocked(vestingPlan), "Requested amount exceeds claimed amount of the user");
        uint256 newTotalTime = _getNewTotalTime(vestingPlan);
        _updateVestingPlan(vestingPlan, block.timestamp, newTotalTime, amount);
    }

    function claimSymm() external{
        _claimSymm(msg.sender);
    }

    function claimSymmFor(address user) external onlyRole(ADMIN_ROLE){
        _claimSymm(user);
    }

    //TODO: change name
    function claimLockedSymm(uint256 amount) external {
        VestingPlan memory vestingPlan = symmVestingPlans[msg.sender];
        _adjustVestingPlan(vestingPlan, amount);
        _claimSymm(msg.sender);
        IERC20(vestingPlan.token).transfer(msg.sender, amount/2);
        IERC20(vestingPlan.token).transfer(feeCollector, amount/2);
    }

    function _claimSymm(address user) internal {
        uint256 availableAmount = getClaimableSymmAmount(user);
        VestingPlan memory vestingPlan = symmVestingPlans[user];
        vestingPlan.claimedAmount += availableAmount;
        IERC20(vestingPlan.token).transfer(user, availableAmount);
    }

    function claimLP() external{
        _claimLP(msg.sender);
    }

    function claimLPFor(address user) external onlyRole(ADMIN_ROLE){
        _claimLP(user);
    }

    //claimLockedLP?

    function _claimLP(address user) internal {
        uint256 availableAmount = getClaimableLPAmount(user);
        VestingPlan memory vestingPlan = LPVestingPlans[user];
        vestingPlan.claimedAmount += availableAmount;
        IERC20(vestingPlan.token).transfer(user, availableAmount);
    }

    function addLiquidity(uint256 amount) external returns(uint256[] memory, uint256){
        _claimSymm(msg.sender);
        VestingPlan memory symmVestingPlan = symmVestingPlans[msg.sender];
        _adjustVestingPlan(symmVestingPlan, amount);
        (uint256[] memory amountsIn, uint256 LPAmountOut) = _addLiquidity(amount);
        VestingPlan memory newLPVestingPlan;
        uint256 LPTotalTime = _getNewTotalTime(symmVestingPlan);
        _updateVestingPlan(newLPVestingPlan, block.timestamp, LPTotalTime, LPAmountOut);
        return (amountsIn, LPAmountOut);
    }

    //TODO: better name?
    function _adjustVestingPlan(VestingPlan memory vestingPlan, uint256 amount) internal{
        uint256 lockedSymmAmount = vestingPlan.totalAmount - _getTotalUnlocked(vestingPlan);
        require(lockedSymmAmount >= amount, "requested amount exceeds total locked amount");
        uint256 newTotalAmount = vestingPlan.totalAmount - amount;
        uint256 newTotalTime = _getNewTotalTime(vestingPlan);
        _updateVestingPlan(vestingPlan, block.timestamp, newTotalTime, newTotalAmount);
    }

    function getClaimableSymmAmount(address user) public view returns(uint256){
        VestingPlan memory vestingPlan = symmVestingPlans[user];
        uint256 totalUnlocked = _getTotalUnlocked(vestingPlan);
        uint256 availableAmount = 0;
        if (totalUnlocked > vestingPlan.claimedAmount)
            availableAmount = totalUnlocked - vestingPlan.claimedAmount;
        return availableAmount;
    }

    function getClaimableLPAmount(address user) public view returns(uint256){
        VestingPlan memory vestingPlan = LPVestingPlans[user];
        uint256 availableAmount = _getTotalUnlocked(vestingPlan);
        availableAmount -= vestingPlan.claimedAmount;
        return availableAmount;
    }

    function _getTotalUnlocked(VestingPlan memory vestingPlan) internal view returns (uint256){
        uint256 endTime = block.timestamp;
        (uint256 startTime, uint256 totalTime) = (vestingPlan.startTime, vestingPlan.totalTime);
        if(endTime > startTime + totalTime)
            endTime = startTime + totalTime;
        uint256 totalUnlocked =
            (
                (vestingPlan.totalAmount * 1e18 / totalTime) *
                (endTime - startTime)
            ) / 1e18;
        return totalUnlocked;
    }

    //TODO: byValue->byReference OR different design
    function _updateVestingPlan(VestingPlan memory vestingPlan, uint256 startTime, uint256 totalTime, uint256 totalAmount) internal view{
        vestingPlan.startTime = startTime;
        vestingPlan.totalTime = totalTime;
        vestingPlan.totalAmount = totalAmount;
        vestingPlan.claimedAmount = 0;
    }

    function _getNewTotalTime(VestingPlan memory vestingPlan) internal view returns(uint256){
        return vestingPlan.startTime + vestingPlan.totalAmount - block.timestamp;
    }

    //TODO: reward claim
}

