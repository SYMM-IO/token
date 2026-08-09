# Symm Token

Solidity contracts, deployment tasks, and upgrade tooling for the SYMM token family. The project uses Hardhat 3 with Ethers v6 and Mocha.

## Contracts

### Symmio

`Symmio` is an ERC-20 token with role-controlled minting.

- `DEFAULT_ADMIN_ROLE`: manages roles; production ownership should normally be a timelock or similarly controlled account.
- `MINTER_ROLE`: mints tokens.

### SymmAllocationClaimer

`SymmAllocationClaimer` stores user allocations and manages claims.

- `DEFAULT_ADMIN_ROLE`: manages roles.
- `SETTER_ROLE`: updates allocation parameters.
- `PAUSER_ROLE`: pauses the contract.
- `UNPAUSER_ROLE`: unpauses the contract.
- `MINTER_ROLE`: executes admin-allocated token claims.

The repository also contains staking, vesting, and Builders NFT contracts. See [the Builders NFT rollout runbook](scripts/builders-nft/README.md) for its upgrade and deployment controls.

## Development

### Requirements

- Node.js 22.13.0 or newer
- npm

Install the pinned dependency graph:

```bash
npm ci
```

Hardhat is installed locally; a global Hardhat installation is not required.

### Commands

```bash
npm run build
npm test
npm run typecheck
npm run test:coverage
npm run test:gas
```

`npm test` currently runs the Builders NFT entry point and rollout-tooling tests: 35 Mocha tests at the time of the Hardhat 3 migration. Other behavior modules are type-checked but are not imported by `tests/main.ts`; add them to an entry point before treating them as runtime test coverage.

List the registered deployment tasks and their parameters with:

```bash
npx hardhat --help
npx hardhat deploy:SymmioToken --help
```

### Network configuration

Create an ignored `.env` file or export the required values in the shell. Never commit private keys or private RPC URLs.

```dotenv
ACCOUNT=0x...
RPC_ETHEREUM=https://...
RPC_BASE=https://...
RPC_POLYGON=https://...
ETHERSCAN_API_KEY=...
```

- `ACCOUNT` is the deployer private key for configured HTTP networks. There is deliberately no fallback key.
- RPC variables override the public defaults in `hardhat.config.ts`.
- `ETHERSCAN_API_KEY` is consumed by the Etherscan v2 verification configuration.
- Local builds and tests do not require these variables because Hardhat resolves configuration variables lazily.

For example:

```bash
npx hardhat deploy:SymmioToken --network base --name SYMM --symbol SYMM --admin 0x...
npx hardhat verify --network base 0x...
```

Always inspect a task's help and preview operational parameters before using a production signer.

## Hardhat 3 migration notes

- The project is ESM (`"type": "module"`). TypeScript source uses `.js` suffixes for relative imports so Node can resolve the emitted modules.
- Tasks are declarative and load action modules lazily. Task actions and scripts explicitly create or reuse a network connection instead of importing a global Ethers runtime.
- OpenZeppelin Upgrades is initialized for the selected network connection. ProxyAdmin ownership remains an explicit deployment parameter where supported by the task.
- Coverage and gas statistics use Hardhat 3's built-in `--coverage` and `--gas-stats` test options; the Hardhat 2 reporter plugins were removed.
- Compiler settings remain on Solidity 0.8.27, optimizer 200 runs, `viaIR`, Paris EVM output, and metadata bytecode hashes disabled. Preserve these settings when verifying or upgrading deployed contracts.
