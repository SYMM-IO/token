# Symm Staking

Staking is a core component of the Symmio ecosystem, designed to reward long-term participation and support for the platform. By staking the native $SYMM token, token holders can directly contribute to the network’s security and liquidity, while earning a portion of the settlement fees generated from derivatives trading. Symmio will use this contract to distribute a portion of protocol fees to Symmio holders. As Symmio is deployed on multiple chains, there might be multiple reward tokens.

## Overview of contract

SymmStaking is an upgradeable, multi-token reward staking contract. It allows users to stake a designated token (SYMM) to earn rewards in multiple whitelisted reward tokens. The contract incorporates security features like access control, reentrancy protection, and pausability. 

In the SymmStaking contract, a user begins by depositing SYMM tokens using the deposit function, specifying an amount and receiver address, which increases their staked balance and the total supply. They earn rewards over time based on their staked amount and the reward rate of whitelisted tokens, which can be checked using earned. To withdraw their staked tokens, users call withdraw, specifying an amount and recipient address, reducing their balance. Finally, users can claim accumulated rewards anytime with claimRewards, transferring all earned reward tokens to their address, while the contract updates reward states throughout these actions to ensure accurate calculations.

### Key Features

* Upgradeable contract using Transparent Upgradeable Proxy pattern
* Multiple reward token support
* Role-based access control
* Reentrancy protection
* Pause/unpause functionality
* Reward calculation based on staking duration
* Emergency token rescue capability

### Roles

* DEFAULT_ADMIN_ROLE: Overall contract administration
* REWARD_MANAGER_ROLE: Manages reward tokens and claims
* PAUSER_ROLE: Can pause the contract
* UNPAUSER_ROLE: Can unpause the contract

### Events

* RewardNotified: When new rewards are added
* Deposit: When tokens are staked
* Withdraw: When tokens are withdrawn
* RewardClaimed: When rewards are claimed
* UpdateWhitelist: When token whitelist status changes
* RescueToken: When tokens are rescued by admin
