// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmioBuildersNftManager
 * @notice Comprehensive manager contract for SymmioBuildersNft that handles all complex logic
 *         including SYMM token locking, unlock processes, merging, fee collection, and cross-chain sync.
 *
 * @dev    Core features include:
 *         • SYMM token locking with burning and without burning (for MINTER_ROLE)
 *         • Lock data management for all NFTs
 *         • NFT merging functionality
 *         • Time-locked unlock functionality
 *         • Fee collector management and notifications
 *         • Cross-chain synchronization capabilities
 *         • Transfer restrictions based on unlock status
 *
 *         This contract acts as the central logic hub while the NFT contract remains simple.
 */

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/// @notice Minimal burnable extension for any ERC‑20 we treat as SYMM.
interface IERC20Burnable is IERC20 {
	function burnFrom(address account, uint256 amount) external;
}

/**
 * @notice Interface for the SymmioBuildersNft contract.
 */
interface ISymmioBuildersNft {
	function mint(address to, string memory brandName) external returns (uint256 tokenId);

	function mintWithId(address to, uint256 tokenId, string memory brandName) external;

	function burn(uint256 tokenId) external;

	function ownerOf(uint256 tokenId) external view returns (address);

	function brandNames(uint256 tokenId) external view returns (string memory);
}

/**
 * @notice Interface for the unlock manager contract handling token unlock processes.
 */
interface ISymmUnlockManager {
	function initiateUnlock(uint256 tokenId, address owner, uint256 amount) external;

	function isUnlocking(uint256 tokenId) external view returns (bool);
}

/**
 * @notice Interface for the fee collector contract handling fee collection.
 */
interface ISymmFeeCollector {
	function onLockedAmountChanged(int256 amount) external;
}

contract SymmioBuildersNftManager is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for minting NFTs without burning SYMM tokens.
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	/// @notice Role for updating configuration parameters.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for pausing the contract operations.
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing the contract operations.
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/// @notice Role for pausing/unpausing NFT transfers specifically.
	bytes32 public constant TRANSFER_PAUSER_ROLE = keccak256("TRANSFER_PAUSER_ROLE");

	/// @notice Role for syncing cross-chain lock data and minting NFTs.
	bytes32 public constant SYNC_ROLE = keccak256("SYNC_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice The SYMM token contract address.
	IERC20Burnable public SYMM;

	/// @notice The SymmioBuildersNft contract.
	ISymmioBuildersNft public nftContract;

	/// @notice The unlock manager contract for handling token unlock processes.
	ISymmUnlockManager public unlockManager;

	/// @notice The minimum amount of SYMM tokens required to mint an NFT.
	uint256 public minLockAmount;

	/// @notice Flag indicating whether NFT transfers are paused.
	bool public transfersPaused;

	/// @notice Mapping of token ID to its comprehensive lock data.
	mapping(uint256 => LockData) public lockData;

	/// @notice Mapping of token ID to its related fee collector addresses.
	mapping(uint256 => address[]) public tokenRelatedFeeCollectors;

	/// @dev This empty reserved space is put in place to allow future versions to add new variables without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/**
	 * @notice Emitted when SYMM tokens are locked and an NFT is minted.
	 * @param user      Address of the user locking tokens.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param brandName Brand name associated with the NFT.
	 */
	event TokenLocked(address indexed user, uint256 indexed tokenId, uint256 amount, string brandName);

	/**
	 * @notice Emitted when an NFT is minted without burning SYMM.
	 * @param minter    Address of the minter.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount associated with the NFT.
	 * @param brandName Brand name associated with the NFT.
	 */
	event NFTMintedWithoutBurn(address indexed minter, address indexed to, uint256 indexed tokenId, uint256 amount, string brandName);

	/**
	 * @notice Emitted when two NFTs are merged into one.
	 * @param targetTokenId ID of the NFT receiving the merged amount.
	 * @param sourceTokenId ID of the NFT being burned.
	 * @param newAmount     New total locked amount in the target NFT.
	 */
	event TokensMerged(uint256 indexed targetTokenId, uint256 indexed sourceTokenId, uint256 newAmount);

	/**
	 * @notice Emitted when an unlock process is initiated for an NFT.
	 * @param tokenId ID of the NFT.
	 * @param owner   Owner of the NFT.
	 * @param amount  Amount of tokens to unlock.
	 */
	event UnlockInitiated(uint256 indexed tokenId, address indexed owner, uint256 amount);

	/**
	 * @notice Emitted when the minimum lock amount is updated.
	 * @param newMinAmount New minimum lock amount.
	 */
	event MinLockAmountUpdated(uint256 newMinAmount);

	/**
	 * @notice Emitted when the unlock manager address is updated.
	 * @param newUnlockManager New unlock manager address.
	 */
	event UnlockManagerUpdated(address newUnlockManager);

	/**
	 * @notice Emitted when the transfer pause state is updated.
	 * @param paused New pause state (true for paused, false for unpaused).
	 */
	event TransfersPausedUpdated(bool paused);

	/**
	 * @notice Emitted when an NFT is minted for cross-chain synchronization.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param brandName Brand name associated with the NFT.
	 */
	event SyncMint(address indexed to, uint256 indexed tokenId, uint256 amount, string brandName);

	/**
	 * @notice Emitted when fee collectors are added to an NFT.
	 * @param tokenId      ID of the NFT.
	 * @param feeCollector Address of the fee collector added.
	 */
	event FeeCollectorAdded(uint256 indexed tokenId, address feeCollector);

	/**
	 * @notice Emitted when fee collectors are removed from an NFT.
	 * @param tokenId      ID of the NFT.
	 * @param feeCollector Address of the fee collector removed.
	 */
	event FeeCollectorRemoved(uint256 indexed tokenId, address feeCollector);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error AmountBelowMinimum(uint256 amount, uint256 minimum);
	error NotTokenOwner();
	error InsufficientLockedAmount();
	error InvalidTokenId();
	error ZeroAddress();
	error ZeroAmount();
	error TransfersPaused();
	error UnlockManagerNotSet();
	error TokenHasActiveUnlock();
	error UnauthorizedAccess(address caller, address requiredCaller);
	error LengthMismatch();

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Comprehensive lock data structure for each NFT.
	 * @param amount           Total amount of SYMM tokens locked.
	 * @param lockTimestamp    Timestamp when the tokens were locked.
	 * @param unlockingAmount  Amount of tokens currently being unlocked.
	 */
	struct LockData {
		uint256 amount;
		uint256 lockTimestamp;
		uint256 unlockingAmount;
	}

	/* ─────────────────────────────── Modifiers ─────────────────────────────── */

	/**
	 * @notice Ensure transfers are not paused and token has no active unlock.
	 * @param tokenId ID of the token to check.
	 */
	modifier transfersAllowed(uint256 tokenId) {
		if (transfersPaused) revert TransfersPaused();
		if (lockData[tokenId].unlockingAmount > 0) revert TokenHasActiveUnlock();
		_;
	}

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the SymmioBuildersNftManager contract.
	 * @param _symm           Address of the SYMM token contract.
	 * @param _nftContract    Address of the SymmioBuildersNft contract.
	 * @param _admin          Address to receive admin and all role assignments.
	 * @param _minLockAmount  Minimum amount of SYMM tokens required to mint an NFT.
	 */
	function initialize(address _symm, address _nftContract, address _admin, uint256 _minLockAmount) public initializer {
		if (_symm == address(0) || _nftContract == address(0) || _admin == address(0)) revert ZeroAddress();
		if (_minLockAmount == 0) revert ZeroAmount();

		// Initialize parent contracts
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		// Set contract-specific state
		SYMM = IERC20Burnable(_symm);
		nftContract = ISymmioBuildersNft(_nftContract);
		minLockAmount = _minLockAmount;

		// Grant all roles to the admin for initial setup
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(MINTER_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);
		_grantRole(TRANSFER_PAUSER_ROLE, _admin);
		_grantRole(SYNC_ROLE, _admin);
	}

	/* ────────────────────── Core NFT & Locking Functions ────────────────────── */

	/**
	 * @notice Mint an NFT by locking SYMM tokens with a custom brand name.
	 * @param amount    Amount of SYMM tokens to lock (must meet minimum requirement).
	 * @param brandName Custom brand name for the NFT.
	 * @return tokenId  ID of the newly minted NFT.
	 *
	 * @dev Burns the SYMM tokens, mints an NFT, stores lock data, and notifies fee collectors.
	 */
	function mintAndLock(uint256 amount, string memory brandName) external nonReentrant whenNotPaused returns (uint256 tokenId) {
		if (amount < minLockAmount) revert AmountBelowMinimum(amount, minLockAmount);

		// Burn the SYMM tokens
		SYMM.burnFrom(msg.sender, amount);

		// Mint new NFT
		tokenId = nftContract.mint(msg.sender, brandName);

		// Store lock data
		lockData[tokenId] = LockData({ amount: amount, lockTimestamp: block.timestamp, unlockingAmount: 0 });

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit TokenLocked(msg.sender, tokenId, amount, brandName);
	}

	/**
	 * @notice Mint an NFT without burning SYMM tokens (for authorized minters).
	 * @param to        Address to mint the NFT to.
	 * @param amount    Amount to associate with the NFT (must meet minimum requirement).
	 * @param brandName Custom brand name for the NFT.
	 * @return tokenId  ID of the newly minted NFT.
	 *
	 * @dev Only callable by MINTER_ROLE. Creates NFT with tracked amount but no token burn.
	 */
	function mintWithoutBurn(
		address to,
		uint256 amount,
		string memory brandName
	) external onlyRole(MINTER_ROLE) nonReentrant whenNotPaused returns (uint256 tokenId) {
		if (amount < minLockAmount) revert AmountBelowMinimum(amount, minLockAmount);

		// Mint new NFT
		tokenId = nftContract.mint(to, brandName);

		// Store lock data (same as regular mint)
		lockData[tokenId] = LockData({ amount: amount, lockTimestamp: block.timestamp, unlockingAmount: 0 });

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit NFTMintedWithoutBurn(msg.sender, to, tokenId, amount, brandName);
	}

	/**
	 * @notice Lock additional SYMM tokens into an existing NFT.
	 * @param tokenId ID of the NFT to lock tokens into.
	 * @param amount  Amount of SYMM tokens to lock.
	 */
	function lock(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused {
		if (nftContract.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

		// Burn the SYMM tokens
		SYMM.burnFrom(msg.sender, amount);

		// Increase the locked amount
		lockData[tokenId].amount += amount;

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit TokenLocked(msg.sender, tokenId, amount, nftContract.brandNames(tokenId));
	}

	/* ────────────────────────── NFT Management ────────────────────────── */

	/**
	 * @notice Merge two NFTs owned by the caller into a single NFT.
	 * @param targetTokenId ID of the NFT to merge into (will receive combined amount).
	 * @param sourceTokenId ID of the NFT to merge from (will be burned).
	 */
	function merge(uint256 targetTokenId, uint256 sourceTokenId) external nonReentrant whenNotPaused {
		if (nftContract.ownerOf(targetTokenId) != msg.sender) revert NotTokenOwner();
		if (nftContract.ownerOf(sourceTokenId) != msg.sender) revert NotTokenOwner();

		LockData storage targetData = lockData[targetTokenId];
		LockData storage sourceData = lockData[sourceTokenId];

		if (targetData.unlockingAmount > 0 || sourceData.unlockingAmount > 0) revert TokenHasActiveUnlock();

		// Merge locked amounts
		uint256 newAmount = targetData.amount + sourceData.amount;
		targetData.amount = newAmount;

		// Notify fee collectors for both NFTs
		_notifyFeeCollectors(targetTokenId, int256(sourceData.amount));
		_notifyFeeCollectors(sourceTokenId, -int256(sourceData.amount));

		// Burn the source NFT and clear its data
		nftContract.burn(sourceTokenId);
		delete lockData[sourceTokenId];

		emit TokensMerged(targetTokenId, sourceTokenId, newAmount);
	}

	/* ──────────────────────── Unlock Functions ──────────────────────── */

	/**
	 * @notice Initiate the unlock process for a portion of an NFT's locked tokens.
	 * @param tokenId ID of the NFT to unlock from.
	 * @param amount  Amount of tokens to unlock.
	 */
	function initiateUnlock(uint256 tokenId, uint256 amount) external nonReentrant {
		if (nftContract.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
		if (address(unlockManager) == address(0)) revert UnlockManagerNotSet();

		LockData storage data = lockData[tokenId];
		uint256 availableAmount = data.amount - data.unlockingAmount;

		if (amount > availableAmount) revert InsufficientLockedAmount();
		if (amount == 0) revert ZeroAmount();

		// Update the unlocking amount
		data.unlockingAmount += amount;

		// Delegate to the unlock manager
		unlockManager.initiateUnlock(tokenId, msg.sender, amount);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, -int256(amount));

		emit UnlockInitiated(tokenId, msg.sender, amount);
	}

	/**
	 * @notice Complete the unlock process for an NFT.
	 * @param tokenId ID of the NFT to unlock.
	 * @param amount  Amount of tokens being unlocked.
	 *
	 * @dev Only callable by the unlock manager. Burns NFT if no tokens remain.
	 */
	function completeUnlock(uint256 tokenId, uint256 amount) external {
		if (msg.sender != address(unlockManager)) revert UnauthorizedAccess(msg.sender, address(unlockManager));

		LockData storage data = lockData[tokenId];
		data.unlockingAmount -= amount;
		data.amount -= amount;

		// Burn the NFT if no locked tokens remain
		if (data.amount == 0) {
			nftContract.burn(tokenId);
			delete lockData[tokenId];
		}
	}

	/**
	 * @notice Cancel an unlock process for an NFT.
	 * @param tokenId ID of the NFT to cancel the unlock for.
	 * @param amount  Amount to cancel from the unlocking process.
	 *
	 * @dev Only callable by the unlock manager.
	 */
	function cancelUnlock(uint256 tokenId, uint256 amount) external {
		if (msg.sender != address(unlockManager)) revert UnauthorizedAccess(msg.sender, address(unlockManager));

		lockData[tokenId].unlockingAmount -= amount;

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));
	}

	/* ───────────────────── Cross-Chain Sync Functions ───────────────────── */

	/**
	 * @notice Mint an NFT without token transfer for cross-chain synchronization.
	 * @param to        Address to mint the NFT to.
	 * @param tokenId   Specific token ID to mint.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param brandName Brand name for the NFT.
	 */
	function syncMint(address to, uint256 tokenId, uint256 amount, string memory brandName) external onlyRole(SYNC_ROLE) whenNotPaused {
		// Mint NFT with specific ID
		nftContract.mintWithId(to, tokenId, brandName);

		// Store lock data
		lockData[tokenId] = LockData({ amount: amount, lockTimestamp: block.timestamp, unlockingAmount: 0 });

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit SyncMint(to, tokenId, amount, brandName);
	}

	/**
	 * @notice Update lock data for multiple NFTs for cross-chain synchronization.
	 * @param tokenIds  Array of token IDs to update.
	 * @param lockDatas Array of lock data to apply.
	 */
	function batchUpdateLockData(uint256[] calldata tokenIds, LockData[] calldata lockDatas) external onlyRole(SYNC_ROLE) {
		if (tokenIds.length != lockDatas.length) revert LengthMismatch();

		for (uint256 i = 0; i < tokenIds.length; i++) {
			uint256 oldAmount = lockData[tokenIds[i]].amount;
			uint256 newAmount = lockDatas[i].amount;
			lockData[tokenIds[i]] = lockDatas[i];

			// Notify fee collectors of the change
			_notifyFeeCollectors(tokenIds[i], int256(newAmount) - int256(oldAmount));
		}
	}

	/* ───────────────────────── Transfer Controls ───────────────────────── */

	/**
	 * @notice Check if an NFT transfer is allowed.
	 * @param tokenId ID of the NFT to check.
	 * @return Whether the transfer is allowed.
	 */
	function isTransferAllowed(uint256 tokenId) external view returns (bool) {
		return !transfersPaused && lockData[tokenId].unlockingAmount == 0;
	}

	/**
	 * @notice Hook called before NFT transfers to check restrictions.
	 * @param from    Address transferring from.
	 * @param to      Address transferring to.
	 * @param tokenId ID of the NFT being transferred.
	 *
	 * @dev Should be called by the NFT contract before transfers.
	 */
	function beforeTokenTransfer(address from, address to, uint256 tokenId) external view {
		// Skip checks for minting (from == address(0)) and burning (to == address(0))
		if (from != address(0) && to != address(0)) {
			if (transfersPaused) revert TransfersPaused();
			if (lockData[tokenId].unlockingAmount > 0) revert TokenHasActiveUnlock();
		}
	}

	/* ───────────────────────── Pause Controls ───────────────────────── */

	/**
	 * @notice Pause the contract, disabling state-changing functions.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpause the contract, enabling state-changing functions.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/**
	 * @notice Set the pause state for NFT transfers.
	 * @param _paused True to pause transfers, false to unpause.
	 */
	function setTransfersPaused(bool _paused) external onlyRole(TRANSFER_PAUSER_ROLE) {
		transfersPaused = _paused;
		emit TransfersPausedUpdated(_paused);
	}

	/* ────────────────────────── Admin Functions ────────────────────────── */

	/**
	 * @notice Set the minimum lock amount for minting NFTs.
	 * @param _minLockAmount New minimum lock amount.
	 */
	function setMinLockAmount(uint256 _minLockAmount) external onlyRole(SETTER_ROLE) {
		if (_minLockAmount == 0) revert ZeroAmount();
		minLockAmount = _minLockAmount;
		emit MinLockAmountUpdated(_minLockAmount);
	}

	/**
	 * @notice Set the address of the unlock manager contract.
	 * @param _unlockManager New unlock manager address.
	 */
	function setUnlockManager(address _unlockManager) external onlyRole(SETTER_ROLE) {
		if (_unlockManager == address(0)) revert ZeroAddress();
		unlockManager = ISymmUnlockManager(_unlockManager);
		emit UnlockManagerUpdated(_unlockManager);
	}

	/**
	 * @notice Add fee collectors to an NFT.
	 * @param tokenId       ID of the NFT to add fee collectors to.
	 * @param feeCollectors Array of fee collector addresses to add.
	 */
	function addFeeCollector(uint256 tokenId, address[] calldata feeCollectors) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < feeCollectors.length; i++) {
			tokenRelatedFeeCollectors[tokenId].push(feeCollectors[i]);
			emit FeeCollectorAdded(tokenId, feeCollectors[i]);
		}
	}

	/**
	 * @notice Remove a fee collector from an NFT.
	 * @param tokenId      ID of the NFT to remove fee collector from.
	 * @param feeCollector Address of the fee collector to remove.
	 */
	function removeFeeCollector(uint256 tokenId, address feeCollector) external onlyRole(SETTER_ROLE) {
		address[] storage collectors = tokenRelatedFeeCollectors[tokenId];
		for (uint256 i = 0; i < collectors.length; i++) {
			if (collectors[i] == feeCollector) {
				collectors[i] = collectors[collectors.length - 1];
				collectors.pop();
				break;
			}
		}
		emit FeeCollectorRemoved(tokenId, feeCollector);
	}

	/* ────────────────────────── View Functions ────────────────────────── */

	/**
	 * @notice Get the effective locked amount for an NFT (excluding unlocking amounts).
	 * @param tokenId ID of the NFT.
	 * @return The effective locked amount available for fee reductions.
	 */
	function getEffectiveLockedAmount(uint256 tokenId) external view returns (uint256) {
		LockData storage data = lockData[tokenId];
		return data.amount - data.unlockingAmount;
	}

	/**
	 * @notice Get lock data for multiple NFTs in a single call.
	 * @param tokenIds Array of token IDs to query.
	 * @return Array of LockData structs.
	 */
	function getLockDataBatch(uint256[] calldata tokenIds) external view returns (LockData[] memory) {
		LockData[] memory result = new LockData[](tokenIds.length);
		for (uint256 i = 0; i < tokenIds.length; i++) {
			result[i] = lockData[tokenIds[i]];
		}
		return result;
	}

	/**
	 * @notice Get the total effective locked amount for a user across all their NFTs.
	 * @param user Address of the user.
	 * @return total Total effective locked amount for fee reduction calculations.
	 */
	function getUserTotalLocked(address user) external view returns (uint256 total) {
		// This would need to iterate through user's NFTs from the NFT contract
		// Implementation depends on how the NFT contract exposes user's tokens
		// For now, returning 0 as placeholder
		return 0;
	}

	/**
	 * @notice Get all fee collectors for a specific NFT.
	 * @param tokenId ID of the NFT.
	 * @return Array of fee collector addresses.
	 */
	function getTokenFeeCollectors(uint256 tokenId) external view returns (address[] memory) {
		return tokenRelatedFeeCollectors[tokenId];
	}

	/* ───────────────────────── Internal Helpers ───────────────────────── */

	/**
	 * @notice Notify all fee collectors for an NFT about locked amount changes.
	 * @param tokenId ID of the NFT.
	 * @param amount  Change in locked amount (positive or negative).
	 */
	function _notifyFeeCollectors(uint256 tokenId, int256 amount) private {
		address[] storage collectors = tokenRelatedFeeCollectors[tokenId];
		for (uint256 i = 0; i < collectors.length; i++) {
			ISymmFeeCollector(collectors[i]).onLockedAmountChanged(amount);
		}
	}

	/**
	 * @notice Get the current contract version.
	 * @return The version string of the current contract.
	 */
	function version() external pure returns (string memory) {
		return "1.0.0";
	}
}
