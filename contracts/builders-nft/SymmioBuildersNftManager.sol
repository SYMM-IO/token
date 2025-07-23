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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import "./interfaces/ISymmioBuildersNft.sol";
import "./interfaces/ISymmBuildersNftUnlockManager.sol";
import "./interfaces/ISymmioBuildersNftManager.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/// @notice Minimal burnable extension for any ERC‑20 we treat as SYMM.
interface IERC20Burnable is IERC20 {
	function burnFrom(address account, uint256 amount) external;
}

/**
 * @notice Interface for the fee collector contract handling fee collection.
 */
interface ISymmFeeCollector {
	function onLockedAmountChanged(int256 amount) external;
}

contract SymmioBuildersNftManager is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, ISymmioBuildersNftManager {
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

	/// @notice Role for syncing cross-chain lock data and minting NFTs.
	bytes32 public constant SYNC_ROLE = keccak256("SYNC_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice The SYMM token contract address.
	IERC20Burnable public SYMM;

	/// @notice The SymmioBuildersNft contract.
	ISymmioBuildersNft public nftContract;

	/// @notice The unlock manager contract for handling token unlock processes.
	ISymmBuildersNftUnlockManager public unlockManager;

	/// @notice The minimum amount of SYMM tokens required to mint an NFT.
	uint256 public minLockAmount;

	/// @notice Mapping of token ID to its related fee collector addresses.
	mapping(uint256 => address[]) public tokenRelatedFeeCollectors;

	/// @dev This empty reserved space is put in place to allow future versions to add new variables without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/**
	 * @notice Emitted when an NFT is minted.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param name      Brand name associated with the NFT.
	 */
	event NFTMinted(address indexed to, uint256 indexed tokenId, uint256 amount, string name);

	/**
	 * @notice Emitted when SYMM tokens are locked and an NFT is minted.
	 * @param user      Address of the user locking tokens.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount of SYMM tokens locked.
	 */
	event TokenLocked(address indexed user, uint256 indexed tokenId, uint256 amount);

	/**
	 * @notice Emitted when an NFT is minted without burning SYMM.
	 * @param minter    Address of the minter.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount associated with the NFT.
	 * @param name      Brand name associated with the NFT.
	 */
	event NFTMintedWithoutBurn(address indexed minter, address indexed to, uint256 indexed tokenId, uint256 amount, string name);

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
	 * @notice Emitted when an unlock process is completed for an NFT.
	 * @param tokenId ID of the NFT.
	 * @param owner   Owner of the NFT.
	 * @param amount  Amount of tokens to unlock.
	 */
	event UnlockCompleted(uint256 indexed tokenId, address indexed owner, uint256 amount);

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
	error UnlockManagerNotSet();
	error TokenHasActiveUnlock();
	error UnauthorizedAccess(address caller, address requiredCaller);
	error LengthMismatch();

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
		tokenId = nftContract.mint(msg.sender, amount, brandName);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit NFTMinted(msg.sender, tokenId, amount, brandName);
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
		tokenId = nftContract.mint(to, amount, brandName);

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
		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		nftContract.updateLockData(tokenId, data.amount + amount, data.unlockingAmount, data.name);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit TokenLocked(msg.sender, tokenId, amount);
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

		ISymmioBuildersNft.LockData memory targetData = nftContract.getLockData(targetTokenId);
		ISymmioBuildersNft.LockData memory sourceData = nftContract.getLockData(sourceTokenId);

		if (targetData.unlockingAmount > 0 || sourceData.unlockingAmount > 0) revert TokenHasActiveUnlock();

		// Merge locked amounts
		uint256 newAmount = targetData.amount + sourceData.amount;
		nftContract.updateLockData(targetTokenId, newAmount, targetData.unlockingAmount, targetData.name);

		// Burn the source NFT and clear its data
		nftContract.burn(sourceTokenId);

		// Notify fee collectors for both NFTs
		_notifyFeeCollectors(targetTokenId, int256(sourceData.amount));
		_notifyFeeCollectors(sourceTokenId, -int256(sourceData.amount));

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

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		uint256 availableAmount = data.amount - data.unlockingAmount;

		if (amount > availableAmount) revert InsufficientLockedAmount();
		if (amount == 0) revert ZeroAmount();

		// Update the unlocking amount
		nftContract.updateLockData(tokenId, data.amount, data.unlockingAmount + amount, data.name);

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

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		nftContract.updateLockData(tokenId, data.amount - amount, data.unlockingAmount - amount, data.name);

		// Burn the NFT if no locked tokens remain
		if (data.amount == 0) nftContract.burn(tokenId);

		emit UnlockCompleted(tokenId, msg.sender, amount);
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

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		nftContract.updateLockData(tokenId, data.amount, data.unlockingAmount - amount, data.name);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));
	}

	/* ───────────────────── Cross-Chain Sync Functions ───────────────────── */

	/**
	 * @notice Mint an NFT without token transfer for cross-chain synchronization.
	 * @param to        Address to mint the NFT to.
	 * @param tokenId   Specific token ID to mint.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param name      Brand name for the NFT.
	 */
	function syncMint(address to, uint256 tokenId, uint256 amount, string memory name) external onlyRole(SYNC_ROLE) whenNotPaused {
		// Mint NFT with specific ID
		nftContract.mintWithId(to, tokenId, amount, name);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit SyncMint(to, tokenId, amount, name);
	}

	/**
	 * @notice Update lock data for multiple NFTs for cross-chain synchronization.
	 * @param tokenIds  Array of token IDs to update.
	 * @param lockDatas Array of lock data to apply.
	 */
	function batchUpdateLockData(uint256[] calldata tokenIds, ISymmioBuildersNft.LockData[] calldata lockDatas) external onlyRole(SYNC_ROLE) {
		if (tokenIds.length != lockDatas.length) revert LengthMismatch();

		for (uint256 i = 0; i < tokenIds.length; i++) {
			uint256 oldAmount = nftContract.getLockData(tokenIds[i]).amount;
			uint256 newAmount = lockDatas[i].amount;
			nftContract.updateLockData(tokenIds[i], lockDatas[i].amount, lockDatas[i].unlockingAmount, lockDatas[i].name);

			// Notify fee collectors of the change
			_notifyFeeCollectors(tokenIds[i], int256(newAmount) - int256(oldAmount));
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
		unlockManager = ISymmBuildersNftUnlockManager(_unlockManager);
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
