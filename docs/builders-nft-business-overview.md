# Symmio Builders NFT

The **Symmio Builders NFT** is an on-chain record of the SYMM locked by a builder. Other products can read this amount and use it as an input to their own rules. Fee reduction is one possible use, but these contracts do not apply a discount or restrict the locked amount to that purpose.

The system also defines how a user can increase, transfer, combine, and eventually reclaim their locked SYMM.

## Product Model

The product has two parts:

- **Builders NFT** — the user-owned ERC-721 that records the builder or brand name, total locked amount, and amount currently going through an unlock.
- **Builders NFT Manager** — the entry point for locking SYMM, creating NFTs, merging them, managing unlocks, vesting, and claims.

In the standard flow, the user's SYMM is burned when it is locked. When SYMM is claimed later, the manager funds the claim and mints any balance deficit. An authorized protocol role can also create an NFT without the initial burn.

## Unlocking Model

| Stage | Meaning for the user |
| --- | --- |
| **Locked** | The amount remains recorded in the NFT and contributes to the effective locked balance exposed to integrations. |
| **Cliff** | After an unlock is requested, the selected amount is reserved for a required waiting period. It no longer contributes to the effective locked balance, the NFT cannot be transferred, and the request can still be cancelled. |
| **Vesting** | After the cliff, the selected amount leaves the NFT and is released linearly over the configured vesting duration. The vested part can be claimed without penalty; the unvested part can be claimed early with a penalty. |

If vesting is started after the cliff has already ended, the schedule still starts from the cliff end, so some SYMM may be immediately claimable.

## User Journey

1. **Create an NFT — `mintAndLock`** — Lock at least the configured minimum SYMM and receive a Builders NFT with a chosen builder or brand name.

2. **Manage the locked balance — `lockIntoNFT`, `merge`, ERC-721 transfers** — Add more SYMM, combine two owned NFTs, or transfer an NFT through `transferFrom` / `safeTransferFrom`. An NFT with a pending unlock cannot be transferred, and an NFT used as the merge source cannot have a pending unlock.

3. **Request or cancel an unlock — `initiateUnlock`, `cancelUnlock`** — Select part or all of the available locked amount. This starts the cliff and reserves the selected amount. The request can be cancelled until vesting begins.

4. **Start vesting and claim — `completeCliffAndStartVesting`, `claimUnlockedToken`, `claimLockedToken`** — After the cliff, create the vesting flow. Claim vested SYMM normally, or claim unvested SYMM early and pay the configured penalty.

The unlock and vesting claim belongs to the address that initiated it; it does not move with a later transfer of the remaining NFT. If the NFT's full amount enters vesting, the empty NFT is burned while its unlock history remains available from the manager.

## Protocol Controls

Protocol roles configure the minimum lock amount, cliff duration, and vesting duration; create authorized NFTs through `mintWithoutBurn`; claim on behalf of beneficiaries; and pause the system. The early-claim penalty and its receiver are fixed in the deployment configuration for the current version.
