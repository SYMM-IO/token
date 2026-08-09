# Builders NFT Base rollout

These scripts deploy the fresh `SymmioBuildersNftManager`, upgrade the existing Builders NFT proxy, and prepare the role grants without putting private keys in JSON, Hardhat configuration, logs, or source control. Addresses, economic parameters, authority expectations, environment-variable names, and file locations come from one JSON file. Runtime progress and signer verification metadata are written atomically to an ignored state JSON so interrupted runs can be resumed safely.

## Authority and transaction split

The configured software-wallet deployer `0x00c2796b3AD3369D604E009D75204D7a15Cc584b` may deploy implementations, the manager proxy, and its dedicated ProxyAdmin. It cannot upgrade the existing NFT proxy or grant the manager its live token roles:

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

The config records only the environment-variable names used for the two software-wallet keys:

```json
"signers": {
  "deployer": {
    "type": "privateKeyEnv",
    "address": "0x00c2796b3AD3369D604E009D75204D7a15Cc584b",
    "privateKeyEnv": "BUILDERS_NFT_DEPLOYER_PRIVATE_KEY"
  },
  "nftProxyAdminOwner": {
    "type": "privateKeyEnv",
    "address": "0xf12239317e985f6772f86407608b166efa3e2f05",
    "privateKeyEnv": "BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY"
  }
}
```

## 2. Compile and verify software-wallet signers

```bash
npx hardhat compile --force
```

Load a private key without putting it in shell history. The value may include or omit the `0x` prefix:

```bash
read -rsp "Deployer private key: " BUILDERS_NFT_DEPLOYER_PRIVATE_KEY; echo
export BUILDERS_NFT_DEPLOYER_PRIVATE_KEY
SIGNER_ROLE=deployer npx hardhat run scripts/builders-nft/verifySigner.ts --network base
unset BUILDERS_NFT_DEPLOYER_PRIVATE_KEY
```

Verify the NFT admin separately:

```bash
read -rsp "NFT admin private key: " BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY; echo
export BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
SIGNER_ROLE=nftProxyAdminOwner npx hardhat run scripts/builders-nft/verifySigner.ts --network base
unset BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
```

The verifier derives the address locally and refuses a mismatch. The ignored state JSON records the verified address, signer type, environment-variable name, and timestamp, but never the key. Verification is optional because every transaction script repeats the same address derivation check immediately before signing.

## 3. Preview, then upgrade the NFT

Preview mode performs live proxy/admin/owner/code-hash checks, compares the old storage layout and ABI with the current artifact, and saves a complete pre-upgrade NFT state snapshot. It sends no transaction and does not read either private-key environment variable:

```bash
npx hardhat run scripts/builders-nft/upgradeNft.ts --network base
```

Execution deploys the implementation with the configured deployer key and calls `upgradeAndCall` with the configured NFT ProxyAdmin-owner key. Both supplied keys are derived and checked against the configured and discovered on-chain addresses before use.

```bash
read -rsp "Deployer private key: " BUILDERS_NFT_DEPLOYER_PRIVATE_KEY; echo
read -rsp "NFT admin private key: " BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY; echo
export BUILDERS_NFT_DEPLOYER_PRIVATE_KEY BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/upgradeNft.ts --network base
unset BUILDERS_NFT_DEPLOYER_PRIVATE_KEY BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
```

After the upgrade, the script verifies the EIP-1967 implementation slot and requires the full supply, token owners, lock data, pause flags, and access-control membership snapshot to be byte-for-byte equivalent to the pre-upgrade snapshot.

## 4. Preview, then deploy the manager

The manager is a fresh transparent proxy; it is not an upgrade of any live manager. Preview validates the implementation and prints every initializer/ownership value loaded from JSON:

```bash
npx hardhat run scripts/builders-nft/deployManager.ts --network base
read -rsp "Deployer private key: " BUILDERS_NFT_DEPLOYER_PRIVATE_KEY; echo
export BUILDERS_NFT_DEPLOYER_PRIVATE_KEY
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/deployManager.ts --network base
unset BUILDERS_NFT_DEPLOYER_PRIVATE_KEY
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
read -rsp "NFT admin private key: " BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY; echo
export BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
EXECUTE=true CONFIRM_CHAIN_ID=8453 npx hardhat run scripts/builders-nft/grantNftRoles.ts --network base
unset BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY
```

Submit the generated timelock `scheduleTransaction` through an eligible proposer workflow, wait at least `minimumDelay`, then submit `executeTransaction` through an eligible executor workflow. Those governance transactions are intentionally not auto-signed by the deployer script.

## Safety properties

- Private keys are read only from the environment-variable names declared in JSON; they are never printed or persisted.
- Every supplied key must derive the exact configured signer address before any transaction is constructed.
- No address, deployment parameter, environment-variable name, accepted ABI removal, or output path is embedded in executable source.
- Transaction execution needs both `EXECUTE=true` and the exact configured `CONFIRM_CHAIN_ID`.
- The scripts discover and verify the existing NFT implementation, ProxyAdmin, and owner from EIP-1967/on-chain calls before acting.
- Saved addresses are never trusted without live bytecode, ownership, runtime-hash, getter, or role verification.
- State and generated role JSON are ignored by Git; the reviewed config and old ABI/storage baseline are tracked.
