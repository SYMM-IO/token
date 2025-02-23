# SymmStaking Contract

## Overview

SymmStaking is an upgradeable, multi-token reward staking contract. It allows users to stake a designated token (SYMM) to earn rewards in multiple whitelisted reward tokens. The contract incorporates security features like access control, reentrancy protection, and pausability. 

Staking is a core component of the Symmio ecosystem, designed to reward long-term participation and support for the platform. By staking the native $SYMM token, token holders can directly contribute to the network’s security and liquidity, while earning a portion of the settlement fees generated from derivatives trading. Symmio will use this contract to distribute a portion of protocol fees to Symmio holders. As Symmio is deployed on multiple chains, there might be multiple reward tokens.

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
