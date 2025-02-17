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
        ERC20 token;
    }

    mapping (address => VestingPlan) public symmVestingPlans;
    mapping (address => VestingPlan) public BPTVestingPlans;

    address public feeCollector;

    function initialize(address admin) public initializer{
        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin); //Check: should they be different
    }

    function setSymmTokenAmount(address user, uint256 amount) external onlyRole(ADMIN_ROLE){
        VestingPlan memory vestingPlan = symmVestingPlans[user];
        require(amount >= vestingPlan.claimedAmount, "Requested amount exceeds claimed amount of the user");//Check claimed or unlocked
//        symmVestingPlans[user].totalAmount = amount;
        uint256 newTotalTime = _getNewTotalTime(vestingPlan);
        _updateVestingPlan(vestingPlan, block.timestamp, newTotalTime, amount);
    }

    function claimSymm() external{ //claim with amount?
        _claimSymm(msg.sender);
    }

    function claimSymmFor(address user) external onlyRole(ADMIN_ROLE){
        _claimSymm(user);
    }

    //amount: before halving
    function claimLockedSymm(uint256 amount) external { //Do we have to claim the remained tokens for the user
        VestingPlan memory vestingPlan = symmVestingPlans[msg.sender];
        uint256 lockedSymmAmount = vestingPlan.totalAmount - _getTotalUnlocked(vestingPlan);
        require(lockedSymmAmount >= amount, "requested amount exceeds total locked amount");
        uint256 newTotalAmount = vestingPlan.totalAmount - amount;
        uint256 newTotalTime = _getNewTotalTime(vestingPlan);
        _updateVestingPlan(vestingPlan, block.timestamp, newTotalTime, newTotalAmount);
        vestingPlan.token.transfer(msg.sender, amount/2);
        vestingPlan.token.transfer(feeCollector, lockedSymmAmount-(amount/2));
    }

    function _claimSymm(address user) internal { //Check should we have some amount that can be freed without time
        uint256 availableAmount = getSymmClaimableAmount(user);
        VestingPlan memory vestingPlan = symmVestingPlans[user];
//        require(availableAmount >= amount, "Requested amount exceeds available amount possible to claim");
        vestingPlan.claimedAmount += availableAmount; //Check the compiler version should avoid O.F.
        //FIX: mint or transfer
        vestingPlan.token.transfer(user, availableAmount);
    }

    function claimBPT() external{
        _claimBPT(msg.sender);
    }

    function claimBPTFor(address user) external onlyRole(ADMIN_ROLE){
        _claimBPT(user);
    }

    //claimLockedBPT?

    function _claimBPT(address user) internal {
        uint256 availableAmount = getBPTClaimableAmount(user);
        VestingPlan memory vestingPlan = BPTVestingPlans[user];
//        require(availableAmount >= amount, "Requested amount exceeds available amount possible to claim");
        vestingPlan.claimedAmount += availableAmount;
        vestingPlan.token.transfer(user, availableAmount);
    }

    function addLiquidity(uint256 amount) external returns(uint256[] memory, uint256){
        _claimSymm(msg.sender);
        VestingPlan memory symmVestingPlan = symmVestingPlans[msg.sender];
        require(symmVestingPlan.totalAmount - _getTotalUnlocked(symmVestingPlan) >= amount, "requested amount exceeds total locked amount");
        uint256 newTotalTime = _getNewTotalTime(symmVestingPlan);
        _updateVestingPlan(symmVestingPlan, block.timestamp, newTotalTime, symmVestingPlan.totalAmount - amount);
        (uint256[] memory amountsIn, uint256 BPTAmountOut) = _addLiquidity(amount);
        VestingPlan memory newBPTVestingPlan;
        uint256 bptTotalTime = _getNewTotalTime(symmVestingPlan); //Check bpttotaltime = now to symmtotaltime
        _updateVestingPlan(newBPTVestingPlan, block.timestamp, bptTotalTime, BPTAmountOut);
        return (amountsIn, BPTAmountOut);
    }

    function setPoolAddress(address _poolAddress) external onlyRole(ADMIN_ROLE){
        _setPoolAddress(_poolAddress);
        //Check event?
    }

    function setRouterAddress(address _routerAddress) external onlyRole(ADMIN_ROLE){
        _setRouterAddress(_routerAddress);
        //Check event?
    }

    function getSymmClaimableAmount(address user) public view returns(uint256){
        VestingPlan memory vestingPlan = symmVestingPlans[user];
        uint256 totalUnlocked = _getTotalUnlocked(vestingPlan);
        uint256 availableAmount = 0;
        if (totalUnlocked > vestingPlan.claimedAmount)
            availableAmount = totalUnlocked - vestingPlan.claimedAmount;
        return availableAmount;
    }

    function getBPTClaimableAmount(address user) public view returns(uint256){
        VestingPlan memory vestingPlan = BPTVestingPlans[user];
        uint256 availableAmount = _getTotalUnlocked(vestingPlan);
//        if (totalUnlocked > vestingPlan.claimedAmount) //Since tokenAmount is not going to change!
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

    //TODO: byValue->byReference
    function _updateVestingPlan(VestingPlan memory vestingPlan, uint256 startTime, uint256 totalTime, uint256 totalAmount) internal view{
        vestingPlan.startTime = startTime;
        vestingPlan.totalTime = totalTime;
        vestingPlan.totalAmount = totalAmount;
        vestingPlan.claimedAmount = 0;
    }

    function _getNewTotalTime(VestingPlan memory vestingPlan) internal view returns(uint256){
        return vestingPlan.startTime + vestingPlan.totalAmount - block.timestamp;
    }
}

