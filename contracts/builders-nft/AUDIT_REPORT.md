# Symmio Builders NFT — Security Review

**Review date:** 2026-08-05  
**Reviewed commit:** `fa4ceffbe47720afdd9c48b39d9358d0fec90d57`  
**Status:** Fresh review; no findings or remediation statuses were carried over from an earlier report.

## Executive summary

The current Builders NFT system was reviewed from scratch for authorization failures, supply and lock accounting errors, vesting math, claim safety, NFT transfer restrictions, pause behavior, denial of service, and frontend-view correctness.

No unprivileged path to steal another user's claim, over-claim a vesting flow, or bypass an active NFT unlock restriction was identified. The vesting flow correctly preserves principal across partial claims, claim state is updated before token transfers, and the manager uses reentrancy protection on state-changing user entry points.

Two medium-severity issues remain. An `OPERATOR_ROLE` holder can force a beneficiary to exit vesting early and pay the configured penalty, and `SETTER_ROLE` can retroactively change the cliff deadline of every pending request. Two lower-severity availability and rounding issues were also confirmed.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 2 |
| Informational | 3 |

## Scope

Primary contracts:

- `contracts/builders-nft/SymmioBuildersNft.sol`
- `contracts/builders-nft/SymmioBuildersNftManager.sol`
- `contracts/builders-nft/libraries/VestingFlowLib.sol`
- `contracts/builders-nft/interfaces/ISymmioBuildersNft.sol`

Supporting material:

- Builders NFT deployment tasks
- Builders NFT Hardhat fixtures and behavior tests
- `contracts/token/symm.sol` for the manager's mint and burn assumptions

The review assumes the configured SYMM and NFT addresses are the intended contracts and that OpenZeppelin 5.1.0 behaves as implemented by the installed dependency. This is a manual review, not formal verification or a guarantee that no additional issue exists.

## Architecture and accounting model

The NFT stores an `amount` and `unlockingAmount`. While a request is in its cliff period, its principal remains in the NFT and contributes to `unlockingAmount`, which also prevents transfer. Starting vesting removes that principal from the NFT and creates a separate `Flow` owned indirectly through its originating unlock request.

Claims do not release escrowed SYMM. The manager mints any balance deficit before transferring a claim. Consequently, the manager's SYMM minting authority and every path capable of creating or increasing NFT lock amounts are part of the token-supply security boundary.

The following accounting relationship held in the reviewed tests for each active flow:

```text
original request amount
= net amount received by beneficiary
+ penalties paid
+ remaining active flow amount
```

`netClaimedAmount` intentionally excludes penalties.

## Findings

### SBN-01 — Medium — An operator can force a beneficiary to pay an early-claim penalty

**Affected code:** `claimLockedTokenFor` and `_claimLockedToken` in `SymmioBuildersNftManager.sol`.

`claimLockedTokenFor(user, flowId, amount)` lets any `OPERATOR_ROLE` holder claim unvested principal without authorization from the beneficiary. The manager first claims the vested portion, then transfers the remaining requested principal early and sends the configured penalty to `lockedClaimPenaltyReceiver`.

The operator cannot redirect the beneficiary's net payment, but it can irreversibly choose the timing of the exit and impose the penalty. With a 20% penalty, an operator can force the user to lose 20% of all unvested principal. With a 100% configured rate, the entire unvested amount can be sent to the penalty receiver.

The initializer grants `OPERATOR_ROLE` to the admin, but the role can later be delegated independently. It should therefore not be treated as a harmless automation role.

**Proof:** A temporary Hardhat proof created a flow for a beneficiary, then used the fixture admin's `OPERATOR_ROLE` to call `claimLockedTokenFor` for the maximum amount. The penalty receiver's balance increased and the user's flow was completely removed without any transaction or signature from the user.

**Recommendation:** Prefer removing `claimLockedTokenFor` while retaining `claimUnlockedTokenFor`. If delegated early claims are required, require a beneficiary signature containing the flow ID, maximum gross amount, maximum penalty, nonce, and deadline. At minimum, document `OPERATOR_ROLE` as custodial authority and keep it behind the same controls as the penalty receiver.

### SBN-02 — Medium — Cliff changes apply retroactively to pending requests

**Affected code:** `initiateUnlock`, `completeCliffAndStartVesting`, `setCliffDuration`, `getCliffEndTime`, `isCliffPassed`, and `getTokenDetails` in `SymmioBuildersNftManager.sol`.

An unlock request stores only `unlockInitiatedTime`. Its cliff deadline is recalculated from the current global `cliffDuration` until vesting starts. A `SETTER_ROLE` holder can therefore shorten a pending user's wait or extend it after the user has already initiated the request.

The `UnlockInitiated` event records the deadline calculated at initiation, but that deadline is not authoritative. After a setting change, `getCliffEndTime`, `isCliffPassed`, `completeCliffAndStartVesting`, and the pending-request value returned by `getTokenDetails` use a different deadline. For a started request, `getTokenDetails` uses the snapshotted `vestingStartTime`, while the two standalone cliff views continue using the current duration, creating an additional view inconsistency.

**Proof:** A temporary Hardhat proof initiated a request with a 10-second cliff, changed the duration to 1,000 seconds, and confirmed that the reported deadline moved by 990 seconds. Starting vesting after the originally emitted deadline then reverted with `CliffNotPassed`.

**Recommendation:** Store `cliffEndTime` in `UnlockRequest` during `initiateUnlock` and use that field in all transitions and views. Treat `setCliffDuration` as configuration for future requests only.

### SBN-03 — Low — Rounding can prevent a valid early claim for small flows

**Affected code:** `VestingFlowLib.unlocked`, `VestingFlowLib.decreaseLockedAmount`, and `_claimUnlockedToken` in `SymmioBuildersNftManager.sol`.

Linear vesting rounds down to whole token units. `_claimUnlockedToken` calls `flow.shrink()` only when the calculated unlocked amount is greater than zero. `_claimLockedToken` then calls `decreaseLockedAmount`, which requires the flow to have been advanced to the current block once vesting has begun.

For a sufficiently small flow, time can have advanced past `startTime` while `unlocked()` still rounds to zero. The flow is not shrunk, and the early claim reverts with `FlowNotShrunk`. For example, a one-wei flow with a 3,600-second duration cannot be early-claimed during the interval in which its vested amount remains below one wei.

**Proof:** A temporary Hardhat proof created a one-wei flow, advanced beyond its vesting start, and confirmed that `claimLockedToken(flowId, 1)` reverted with `FlowNotShrunk`.

**Recommendation:** Advance the flow before decreasing locked principal even when the computed unlocked amount is zero. Keep token transfer and event emission conditional on a nonzero unlocked amount, but do not make state advancement conditional on that rounded result.

### SBN-04 — Low — Unbounded arrays can make history views and flow cleanup unavailable

**Affected code:** `cancelUnlock`, `getTokenDetails`, and `_removeUserFlowId` in `SymmioBuildersNftManager.sol`.

Users can split an NFT amount into many one-wei unlock requests. Started requests remain permanently in `tokenUnlockIds`, and active flows accumulate in `_userFlowIds` until claimed.

- `getTokenDetails` copies and enriches every non-cancelled request for a token without pagination.
- `cancelUnlock` scans the token's request IDs to remove one entry.
- Completing a flow calls `_removeUserFlowId`, which scans the user's active-flow IDs.

At sufficiently large counts, frontend `eth_call` requests can exceed RPC gas limits and state-changing cleanup calls can exceed the block gas limit. Creating the problematic state costs the affected user gas, so this is primarily a self-denial-of-service and integration-availability issue rather than a cross-user attack.

**Recommendation:** Add a paginated enriched-details function, maintain index-plus-one mappings for constant-time removal, and consider a minimum unlock-request amount or a per-token active-request limit.

### SBN-05 — Informational — Lock timestamps do not represent the age of all included principal

`updateLockData` always preserves the NFT's original `lockTimestamp`. `lockIntoNFT` adds new principal without changing it, and `merge` gives source principal the target NFT's timestamp.

No reviewed Builders NFT function uses `lockTimestamp` for vesting or claims. However, a downstream integration that treats it as the age of the entire amount can be manipulated by adding new principal to an old NFT or merging into the older token.

**Recommendation:** Document the field as the NFT creation timestamp if that is its intended meaning. If downstream rewards depend on principal age, track deposits independently or define an explicit weighted-age policy.

### SBN-06 — Informational — Privileged roles form a direct SYMM supply authority

`MINTER_ROLE` on the manager can call `mintWithoutBurn` for an arbitrary amount. That amount can enter vesting and cause the manager to mint SYMM when claimed. Separately, NFT `MINTER_ROLE` can mint NFTs or increase existing lock amounts through `updateLockData`; those amounts are also redeemable through the manager.

This behavior is explicit in the design, but it means these roles are economically equivalent to delayed SYMM minting authority rather than ordinary NFT metadata roles.

**Recommendation:** Place manager and NFT administration behind a timelock/multisig, grant operational roles narrowly, monitor all role changes and unbacked mint events, and consider issuance caps if the role will be delegated.

### SBN-07 — Informational — The initializer accepts a zero minimum lock amount

The deployment task rejects `minlockamount <= 0`, and `setMinLockAmount` rejects zero, but `initialize` does not validate `_minLockAmount`. A direct deployment can therefore initialize the manager with zero and mint zero-value NFTs through `mintAndLock` or `mintWithoutBurn`.

This does not create a direct token-loss path, but the on-chain invariant differs from the deployment and setter invariants.

**Recommendation:** Revert with `ZeroAmount` when `_minLockAmount == 0` during initialization.

## Positive security properties

- Implementation constructors disable initialization.
- User-facing state transitions use `nonReentrant` and `whenNotPaused`.
- The manager and NFT coordinate global pause state atomically when roles are wired correctly.
- NFT transfers are blocked while `unlockingAmount` is nonzero.
- Unlock completion is restricted to the request owner and cannot run twice.
- Claim functions validate the flow through its originating request owner.
- Flow principal and `totalVested` are reduced before external token transfers.
- `SafeERC20` is used for claim and penalty transfers.
- Fully claimed flows are removed from active user flow lists.
- ERC-165 advertises the custom NFT interface.

## Verification performed

- Manual line-by-line review of all scoped Solidity files.
- Review of deployment role wiring and the SYMM mint/burn implementation.
- `npx hardhat test`: **28 passing, 0 failing**.
- Three temporary audit proof tests: **3 passing, 0 failing**. The temporary file was removed after execution.
- Existing repeated-partial-claim regression coverage confirms principal conservation and `totalVested` consistency.
- `git diff --check` was used to check the final report change.

Slither and Solhint were not installed in the repository environment, so this report does not claim results from either tool. No fuzzing, invariant framework, symbolic execution, or formal verification was performed.

## Recommended remediation order

1. Remove or require beneficiary authorization for forced penalized operator claims (`SBN-01`).
2. Snapshot cliff deadlines per unlock request (`SBN-02`).
3. Fix zero-rounded flow advancement (`SBN-03`).
4. Bound or paginate request/history operations and make removal constant-time (`SBN-04`).
5. Explicitly document and operationally secure all supply-authority roles (`SBN-06`).
6. Add fuzz/invariant tests for claim conservation, penalty accounting, request lifecycle transitions, and high-cardinality arrays before production deployment.
