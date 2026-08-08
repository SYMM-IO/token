# Builders NFT Base rollout

These scripts deploy the fresh `SymmioBuildersNftManager`, upgrade the existing Builders NFT proxy, and prepare the role grants without putting private keys in Hardhat or source control. Addresses, economic parameters, authority expectations, file locations, and Ledger scan ranges come from one JSON file. Runtime progress and discovered Ledger candidate IDs are written atomically to an ignored state JSON so interrupted runs can be resumed safely.

## Authority and transaction split

The configured deployer `0x00c2796b3AD3369D604E009D75204D7a15Cc584b` may deploy implementations, the manager proxy, and its dedicated ProxyAdmin. It cannot upgrade the existing NFT proxy or grant the manager its live token roles:

- The existing NFT `ProxyAdmin.owner()` upgrades the NFT and the NFT `DEFAULT_ADMIN_ROLE` grants its four manager roles.
- The SYMM timelock schedules and later executes the manager's `MINTER_ROLE` grant.
- The manager's own admin and ProxyAdmin owner are explicit config values and may be different addresses.

The role preparation script reconstructs the timelock's live proposer and executor membership from `RoleGranted`/`RoleRevoked` logs, verifies each result with `hasRole`, and reads the live minimum delay and operation ID. The deployment block is found by binary-searching historical bytecode, and the log chunk size comes from JSON. It never invents a caller when several accounts are eligible.

## 1. Configure

Copy or edit `config/builders-nft.base.json`. The known live contract and signer addresses are already recorded. Supply every currently `null` manager field:

- `admin`: receives the manager's default admin, setter, pauser, unpauser, operator, and manager-minter roles.
- `proxyAdminOwner`: owns only the new manager proxy's ProxyAdmin.
- `minLockAmount`: token amount in wei.
- `cliffDuration` and `vestingDuration`: seconds.
- `penaltyRate`: 18-decimal fixed point, where `100000000000000000` is 10%.
- `penaltyReceiver`: receives early-claim penalties.

The current source is the rollout source of truth: `lockData` is intentionally internal, while `getLockData(uint256)` is the supported external getter. The config therefore lists `"lockData(uint256)"` in `upgrade.acceptedRemovedFunctions` as an explicit acknowledgement that the compiler-generated legacy getter is removed.

That acceptance only acknowledges the ABI removal. It does not bypass the independent storage-layout comparison, runtime bytecode checks, or the pre/post-upgrade NFT state snapshot.

Set the config path for every command:

```bash
export BUILDERS_NFT_CONFIG="$PWD/scripts/builders-nft/config/builders-nft.base.json"
```

## 2. Compile and install optional Ledger transport

The Ledger packages are loaded only when signing. Install them without modifying `package.json` or `package-lock.json`:

```bash
npm install --no-save --package-lock=false @ledgerhq/hw-transport-node-hid-noevents @ledgerhq/hw-app-eth
npx hardhat compile --force
```

Unlock the Ledger, open the Ethereum application, and connect only the device for the requested signer. Candidate schemes and scan counts come from JSON. The first match is saved with its numeric `candidateId`, exact derivation path, scheme, and indices:

```bash
LEDGER_ROLE=deployer npx hardhat run scripts/builders-nft/discoverLedger.ts --network base
LEDGER_ROLE=nftProxyAdminOwner npx hardhat run scripts/builders-nft/discoverLedger.ts --network base
```

The second command can be run by the NFT admin separately. It is optional because each execution script automatically scans and persists its required Ledger signer before signing.

## 3. Preview, then upgrade the NFT

Preview mode performs live proxy/admin/owner/code-hash checks, compares the old storage layout and ABI with the current artifact, and saves a complete pre-upgrade NFT state snapshot. It sends no transaction and does not open the Ledger:

```bash
npx hardhat run scripts/builders-nft/upgradeNft.ts --network base
```

Execution deploys the implementation with the deployer Ledger, then opens/scans the Ledger belonging to the discovered live ProxyAdmin owner for `upgradeAndCall`. If those are different devices, rerun after the implementation deployment with the owner device connected; the saved implementation is verified and reused.

```bash
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/upgradeNft.ts --network base
```

After the upgrade, the script verifies the EIP-1967 implementation slot and requires the full supply, token owners, lock data, pause flags, and access-control membership snapshot to be byte-for-byte equivalent to the pre-upgrade snapshot.

## 4. Preview, then deploy the manager

The manager is a fresh transparent proxy; it is not an upgrade of any live manager. Preview validates the implementation and prints every initializer/ownership value loaded from JSON:

```bash
npx hardhat run scripts/builders-nft/deployManager.ts --network base
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/deployManager.ts --network base
```

Execution reuses the existing manager deployment task, disables its legacy inline role grants, sets the dedicated ProxyAdmin owner explicitly, verifies all initializer getters and ownership on-chain, then records the proxy, implementation, ProxyAdmin, owner, and transaction hash in state.

## 5. Prepare and execute role grants

Create the ignored JSON package only after the manager address is recorded:

```bash
npx hardhat run scripts/builders-nft/prepareRoleTransactions.ts --network base
```

The file path is `files.roleTransactions` in config. It contains:

- four NFT `grantRole` transactions signed by the NFT admin;
- the underlying SYMM `grantRole` call executed by the timelock;
- exact timelock `schedule` and `execute` calldata;
- live proposer/executor candidates, minimum delay, predecessor, salt, and operation ID.

Preview and execute the NFT grants from that generated JSON:

```bash
npx hardhat run scripts/builders-nft/grantNftRoles.ts --network base
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/grantNftRoles.ts --network base
```

Submit the generated timelock `scheduleTransaction` through an eligible proposer workflow, wait at least `minimumDelay`, then submit `executeTransaction` through an eligible executor workflow. Those governance transactions are intentionally not auto-signed by the deployer script.

## Safety properties

- No private key is read by these rollout scripts.
- No address, deployment parameter, scan bound, accepted ABI removal, or output path is embedded in executable source.
- Transaction execution needs both `EXECUTE=true` and the exact configured `CONFIRM_CHAIN_ID`.
- The scripts discover and verify the existing NFT implementation, ProxyAdmin, and owner from EIP-1967/on-chain calls before acting.
- Saved addresses are never trusted without live bytecode, ownership, runtime-hash, getter, or role verification.
- State and generated role JSON are ignored by Git; the reviewed config and old ABI/storage baseline are tracked.
