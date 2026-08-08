# SymmioBuildersNft Audit And Fix Notes

Date: July 23, 2026

## Scope

Reviewed components:

- `contracts/builders-nft/SymmioBuildersNft.sol`
- `contracts/builders-nft/SymmioBuildersNftManager.sol`
- `contracts/builders-nft/interfaces/ISymmioBuildersNft.sol`
- `tasks/symmioBuildersNftManager.ts`
- The manager's vesting payout path exercised through `VestingV2`

## Fixed Issues

### 1. Unlock completion did not reduce the NFT's locked principal

Severity: High

Problem:

- `completeCliffAndStartVesting` removed `unlockingAmount` but left `amount` unchanged.
- Partial unlocks therefore kept overstating the NFT's effective locked balance.
- Full unlocks did not naturally burn the NFT unless storage was manually adjusted first.

Fix:

- On vesting start, the manager now subtracts the unlocked amount from `amount` and from `unlockingAmount`.
- The NFT is burned automatically when both values reach zero.

Effect:

- Locked-balance accounting now matches the actual amount still represented by the NFT.
- Fully unlocked positions now cleanly retire their NFT.

### 2. Anyone could top up another user's NFT by burning their own SYMM

Severity: Medium

Problem:

- `lock` had no ownership check.
- Any address could burn its own SYMM to change another holder's NFT position.

Fix:

- `lock` now requires `msg.sender` to own the target NFT.

Effect:

- Only the NFT holder can mutate the lock amount tied to that position.

### 3. Privileged NFT lock updates allowed impossible states

Severity: Medium

Problem:

- `updateLockData` accepted `unlockingAmount > amount`.
- `getLockData` and `getEffectiveLockedAmount` also accepted nonexistent token IDs through raw mapping reads.
- This could create malformed state and later underflows in view/accounting logic.

Fix:

- `SymmioBuildersNft` now validates token existence on lock-data reads and writes.
- `updateLockData` now rejects invalid lock records where `unlockingAmount > amount`.

Effect:

- Admin/sync paths can no longer write contradictory lock state.
- Batch sync now fails fast if it tries to import broken data.

### 4. Deleted unlock requests still looked valid in view helpers

Severity: Medium

Problem:

- `getCliffEndTime` and `isCliffPassed` only checked `unlockId < _unlockIdCounter`.
- After `cancelUnlock`, the request storage was deleted but those view helpers still returned derived values for the cleared slot.

Fix:

- Both view helpers now also require `unlockRequests[unlockId].amount != 0`.

Effect:

- Cancelled unlock requests now correctly report `UnlockNotFound`.

### 5. Fee collector management allowed duplicate and misleading configuration

Severity: Low

Problem:

- `addFeeCollector` allowed duplicates and zero addresses.
- `removeFeeCollector` emitted a removal event even when nothing was removed.

Fix:

- Added duplicate and zero-address validation on add.
- `removeFeeCollector` now reverts when the collector is not registered.

Effect:

- Fee collector registration is deterministic and event output now matches real state transitions.

### 6. Deployment wiring left vesting payouts and penalty config unsafe

Severity: Medium

Problem:

- The deploy task used `lockedClaimPenalty = 20`, while the contract expects 1e18-scaled precision. That value is effectively near-zero, not 20%.
- The deploy task also did not grant the manager the token/NFT roles it needs for vesting payouts and NFT lifecycle operations.

Fix:

- The deploy task now uses `ethers.parseUnits("0.2", 18)` for a 20% penalty.
- The deploy task now grants:
  - SYMM `MINTER_ROLE` to the manager
  - NFT `MINTER_ROLE` to the manager
  - NFT `BURNER_ROLE` to the manager
- The manager now rejects penalties above `1e18`.

Effect:

- New deployments come up with the permissions required for the vesting claim path.
- Penalty configuration now matches the documented fixed-point scale.

## Tests Added Or Updated

- Unlock completion now proves `amount` is reduced.
- Full unlock now proves the NFT burns without manual storage edits.
- Vesting payout now proves the manager can mint payout tokens during claim flow.
- Locking now proves non-owners are rejected.
- Batch sync now proves invalid lock records are rejected.
- Fee collector tests now cover duplicates, zero address, and missing-removal cases.
- Unlock view helpers now prove cancelled requests revert.

## Residual Notes

### Existing deployments

- Any already-deployed manager/NFT instances should be checked for:
  - overstated `amount` values on unlocks already moved into vesting
  - missing SYMM/NFT role grants on the manager
  - duplicate fee collectors in stored arrays

### Fee collector trust model

- Fee collector callbacks are still synchronous and trusted.
- A reverting fee collector can still block lock/unlock/merge flows for the affected token until an authorized setter removes that collector.
- This was left unchanged because swallowing those failures would hide accounting desynchronization instead of surfacing it.

## Verification

Validated with:

- `npx hardhat test tests\main.ts`

Result:

- 56 passing tests
