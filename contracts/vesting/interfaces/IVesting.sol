// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface IVesting {
    function pause() external;
    function unpause() external;

    function resetVestingPlans(address token, address[] memory users, uint256[] memory amounts) external;
    function setupVestingPlans(address token, uint256 startTime, uint256 endTime, address[] memory users, uint256[] memory amounts) external;

    function claimUnlockedToken(address token) external;
    function claimUnlockedTokenFor(address token, address user) external;

    function claimLockedToken(address token, uint256 amount) external;
    function claimLockedTokenByPercentage(address token, uint256 percentage) external;

    function claimLockedTokenFor(address token, address user, uint256 amount) external;
    function claimLockedTokenForByPercentage(address token, address user, uint256 percentage) external;

    function getLockedAmountsForToken(address user, address token) external view returns (uint256);
    function getClaimableAmountsForToken(address user, address token) external view returns (uint256);
    function getUnlockedAmountForToken(address user, address token) external view returns (uint256);

    function lockedClaimPenalty() external view returns (uint256);
    function lockedClaimPenaltyReceiver() external view returns (address);
    function vestingPlans(address token, address user) external view returns (
        uint256 totalAmount,
        uint256 claimedAmount,
        uint256 startTime,
        uint256 endTime
    );
    function totalVested(address token) external view returns (uint256);
}
