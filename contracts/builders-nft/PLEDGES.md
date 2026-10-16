# SYMMIO NFT pledges in NFTManager

This feature adds custody to the existing upgradeable `SymmioBuildersNftManager`, version `1.1.0`. No separate escrow is deployed. The implementation and preparation tooling do not deploy, upgrade, propose Safe transactions, transfer NFTs or grant ADL access automatically.

## Authority and lifecycle

The existing proxy upgrade authority remains unchanged. A one-time `initializePledges(controller, minimumCollateral)` sets the SYMMIO Safe as pledge controller and seizure recipient, plus a contract-wide automatic collateral minimum. Neither value has a setter. Initialization is restricted to a manager administrator or the proxy's ERC-1967 admin; the latter supports atomic `ProxyAdmin.upgradeAndCall` initialization. The implementation's initializer is disabled, and users cannot pledge before this protocol initialization.

The controller is independent of `OPERATOR_ROLE`, `SETTER_ROLE` and `DEFAULT_ADMIN_ROLE`. Those roles do not authorize release, whole-NFT seizure or partial seizure. Existing upgrade authority can still change these rules through an upgrade. NFT privileged roles and transfer restrictions remain applicable.

1. The NFT owner approves the manager on the NFT, then calls **`lockNftAsPledgeForSymmio(tokenId)`**. No prior SYMMIO approval or per-NFT configuration is required. An approved operator cannot pledge on the owner's behalf.
2. The manager checks that the caller owns the NFT, its represented amount meets `minimumPledgeCollateral`, there are no pending unlocks and this token ID has never been pledged. It atomically takes custody and records the caller as the fixed beneficiary plus the represented amount at deposit.
3. Only the Safe can release or seize collateral. **`releasePledgedNft(tokenId)`** returns the original NFT and its remaining collateral to the beneficiary. **`seizePledgedNft(tokenId)`** transfers the original NFT and its whole remaining amount to the Safe. **`partiallySeizePledgedNft(tokenId, amount)`** splits the specified amount into a new NFT for the Safe and leaves the original pledge active. None accepts a recipient argument. Release and whole-NFT seizure end the lifecycle; that token ID cannot be pledged again.

There are **no pledge time restrictions**: no duration, expiry, earliest release or independent user withdrawal. Manager/NFT pauses and pending-unlock restrictions can still block transfers. Failed transfers revert the entire settlement so it can be retried.

Whole-NFT seizure transfers the original NFT with its remaining represented amount. Partial seizure moves represented SYMM from the original NFT into a newly minted NFT, preserving their combined amount. Neither operation mints liquid SYMM, redeems collateral or confiscates earlier vesting flows. Pledging and partial seizure do not change `totalVested` or the ownership of existing unlock/vesting requests. The beneficiary record remains available for future attribution; no rebate integration is included.

## Partial seizure

For an 8,800,000 SYMM pledge, `partiallySeizePledgedNft(tokenId, 1000000000000000000000000)` seizes 1,000,000 SYMM in represented value:

- The original NFT stays in manager custody, with 7,800,000 SYMM, its original token ID, brand, lock timestamp and beneficiary, and status `Locked`.
- A new Builder NFT is minted directly to the Safe with 1,000,000 SYMM, the same brand and a new mint-time lock timestamp. It is not itself a pledge. Its owner can use the existing NFT transfer and unlock/vesting flows.
- The deposit snapshot in `nftPledges(tokenId).collateralAmount` remains 8,800,000. `partiallySeizedCollateral(tokenId)` records the cumulative amount split out; it excludes later whole-NFT seizure. Read `nftContract.getLockData(tokenId).amount` for the live remainder.
- `PledgedNftPartiallySeized` links the original token ID, new token ID, fixed recipient, seized amount and resulting remainder. The method also returns the new token ID.

The amount must be positive and strictly below the live remaining collateral. Use whole-NFT seizure for the entire remainder. Repeated partial seizures are allowed, including amounts and remainders below the deposit minimum; that minimum is checked only when the user first pledges. The original NFT remains locked until the Safe releases or seizes it, with no pledge time restrictions.

Partial seizure requires actual custody, no pending unlocks, and the manager's existing NFT mint/update authority. Manager pause, NFT global pause and the NFT's independent transfer pause all block it. Failure to update or mint, or rejection by the recipient, reverts the balance reduction, counter and new NFT together. Receiver callbacks cannot reenter pledge mutation methods. A raw resend of a seized child NFT follows the never-pledged NFT recovery route to the Safe.

## Status and accidental transfers

`nftPledges(tokenId)` exposes beneficiary, amount at deposit, status and settlement recipient. The global threshold is exposed by `minimumPledgeCollateral()`. Status values are `0 None`, `1 Locked`, `2 Released`, `3 Seized`. `isPledgedNftInCustody(tokenId)` reports actual ownership independently, including false after a privileged burn.

Accept a pledge operationally only when **status is Locked AND actual custody is true**. Re-read the NFT's live represented amount and pending unlocks before granting ADL access; the deposit amount is a historical snapshot.

The intended entry is the explicit pledge method. Unsolicited `safeTransferFrom` calls are rejected, including transfers from the NFT owner. This prevents accepting NFTs without the entrypoint's checks.

| Recovery method                             | Behaviour                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `recoverSettledPledgedNft(tokenId)`         | Safe-only recovery of an accidental raw resend after release/seizure, only to its recorded settlement recipient.                           |
| `recoverUnrelatedPledgeNft(token, tokenId)` | Safe-only recovery of other collections or never-pledged Builder NFTs to the Safe. Always rejects pledged IDs, including after settlement. |

**Use the explicit pledge method.** A never-pledged Builder NFT sent through ordinary `transferFrom` bypasses validation and has no authenticated beneficiary. It cannot be registered as a pledge after the fact: ERC721 does not expose its previous owner. Only the Safe can recover it, exclusively to the Safe, for a separately handled return. No generic ERC20 sweep is added; the manager may hold tokens backing existing claims.

## Carbon configuration and unsigned calldata

Public parameters are in `configs/carbon-builder-nft-pledge.json`:

| Parameter                               | Value                                        |
| --------------------------------------- | -------------------------------------------- |
| Chain                                   | Base, 8453                                   |
| Existing manager proxy                  | `0xf3fa4c007e4170b1b2db238dec16516fa9b99dbb` |
| NFT                                     | `0x573316D53C6A6685163ba6a602F7c1f20A8E03D2` |
| Token ID                                | 1                                            |
| Beneficiary                             | `0x5750D70f57658b8A28a8ae659c3f8020B9D4117f` |
| Pledge controller and seizure recipient | `0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9` |
| Global minimum collateral               | `8800000000000000000000000` = 8,800,000 SYMM |

The 8,800,000 SYMM minimum applies automatically at entry to every pledge, not just Carbon; a partial seizure may leave less than this minimum. Carbon's address and token ID are calldata inputs, not an on-chain allowlist. The beneficiary is always the actual caller at deposit.

Prepare files without signing or broadcasting:

```sh
npx hardhat --config hardhat.pledge.config.ts pledge:prepare
```

`artifacts/pledge/user-initiated/carbon-preparation.json` contains the unsigned implementation creation transaction, compiler version, initialization calldata, a clearly incomplete upgrade template, Carbon's NFT approval and pledge calldata, and Safe release/seizure calldata. Separate `.release.safe.json` and `.seize.safe.json` files are generated; release and seizure are alternatives and must not be batched together. The `.solc-input.json` file contains exact standard-JSON compiler input for later source verification.

Prepare a separate unsigned partial seizure only after choosing an explicit amount in SYMM base units (example: 1,000,000 SYMM):

```sh
npx hardhat --config hardhat.pledge.config.ts pledge:prepare-partial-seizure \
  --amount 1000000000000000000000000
```

The output is `artifacts/pledge/user-initiated/partial-seizure-1-1000000000000000000000000.safe.json`. No seizure amount is selected by default. This offline task checks encoding and positivity, but cannot validate the live remainder or custody. Verify those values and simulate before any future signing. Seizure, partial seizure and release files are separate actions, not an instruction to execute all of them.

These files do not establish that the manager has been upgraded or that the NFT is in custody. Deposits require the one-time protocol initialization, followed only by the owner's approval and pledge transactions. This configuration sets no Base signing accounts. The `user-initiated` output directory separates these files from earlier approval-based draft artifacts; discard those older artifacts.

## Upgrade preparation and governance

At Base snapshot **52674060**, the existing manager's ProxyAdmin owner was **`0x8CF65060CdA270a3886452A1A1cb656BECEE5bA4`**. This is different from the pledge-controller Safe. The fork test checks that the Safe cannot upgrade that proxy and that the existing owner can initialize pledges atomically during an upgrade. Do not identify the owner as a particular person or organization without separate verification. Re-read current ownership before any future upgrade.

The reviewed baseline is `develop` revision `493837da4bf33f2c194dc500f835a1bb39f7dc74`. `tests/fixtures/builder-nft-manager-v1-storage.json` records its OpenZeppelin storage layout, source hash, compiler and runtime hash. The fork requires the existing implementation's runtime to match that baseline exactly. The upgrade appends `pledgeController`, `minimumPledgeCollateral`, `nftPledges` and `partiallySeizedCollateral` after all previous state. It does not change V1 variables, struct layouts or initial initialization arguments. This replaces the earlier undeployed per-NFT approval draft; it is validated as an upgrade from the recorded V1 baseline, not from that draft's storage layout.

When an upgrade is separately authorized:

1. Verify the live manager implementation, ProxyAdmin, its owner, NFT pairing and administrator roles against the expected deployment. Rerun storage validation and fork tests against the intended live baseline. If the baseline differs, reassess compatibility before proceeding.
2. Deploy and source-verify the new implementation with Solidity 0.8.27 and the prepared standard-JSON settings. Implementation constructor arguments are empty. Validate its runtime and disabled initialization.
3. The **existing ProxyAdmin owner** calls `upgradeAndCall(managerProxy, newImplementation, initializePledges(SYMMIO_SAFE, MINIMUM_COLLATERAL))`. Initializing within this transaction avoids an unconfigured interval. Do not change proxy ownership or manager roles implicitly.
4. Verify the implementation slot, unchanged proxy/admin addresses and existing accounting, `version() == "1.1.0"`, `pledgeController() == SYMMIO_SAFE`, and `minimumPledgeCollateral() == MINIMUM_COLLATERAL`.
5. Carbon approves the manager and calls the pledge method without any preceding Safe transaction. Confirm the receipt, `NftPledged` event, beneficiary, Locked status, actual ownership, live represented amount and zero pending unlocks.
6. Handle any ADL grant separately after custody is verified. No protocol role, solver or ADL permission is inferred here.

## Validation and rollback

```sh
npm ci
npx hardhat --config hardhat.pledge.config.ts test tests/builderNftPledge.test.ts tests/builderNftPledge.tooling.ts tests/main.ts
npx tsc --noEmit -p tsconfig.pledge.json
BASE_FORK_RPC_URL=https://mainnet.base.org BASE_FORK_BLOCK=52674060 \
  npx hardhat --config hardhat.pledge.config.ts test --no-compile tests/builderNftPledge.fork.ts
```

Fork transactions run only inside local Hardhat and impersonate the existing upgrade owner, Carbon and the Safe. They do not test Safe signatures or send transactions to Base. Hardhat 2.22 has no Base activation history, so this uses a local Cancun interpreter with Paris-compiled bytecode; it is not a Base consensus or fee simulation. Fork tests are skipped without the explicit RPC and pinned block configuration.

The scoped TypeScript check covers pledge tests/tasks and their dependencies. The global check includes existing errors in unrelated scripts and disabled vesting/staking tests.

Validation on 2026-10-16: 78 local tests passed (39 pledge, five preparation/calldata, and 34 existing NFT/manager tests), and all five Base fork tests passed at source block 52674060. This includes repeated partial seizure, collateral conservation, fixed recipients, pauses, revoked mint authority, receiver rejection, reentrancy and release/seizure of the remainder. OpenZeppelin implementation and storage-layout checks passed. The pledge-specific TypeScript check passed; the global check still reports the legacy errors described above.

Release scope: manager implementation, public configuration, unsigned preparation tooling, tests and this runbook. NFT and SYMM contracts are unchanged. No new environment secrets, database migration or rebate migration is needed. `BASE_RPC_URL`, `BASE_FORK_RPC_URL` and `BASE_FORK_BLOCK` are documented in `.env.example`.

No production deployment or upgrade has been performed. Before accepting deposits, an unused upgrade can be reconsidered through the existing governance process. After custody begins, do not downgrade to V1: it has no pledge release methods and would strand the NFTs. Settle all custody, including accidental raw deposits, or deploy a storage-compatible repair that preserves pledge recovery. Reinitialization cannot be repeated to choose a different controller or collateral minimum.
