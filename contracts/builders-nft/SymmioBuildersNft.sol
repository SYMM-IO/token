// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmioBuildersNft
 * @notice Advanced ERC721 NFT contract for locking SYMM tokens on the Base chain to enable
 *         fee reductions across multiple chains. Each NFT represents a locked amount of SYMM
 *         tokens with customizable branding and comprehensive unlock management capabilities.
 *
 * @dev    Core features include:
 *         • SYMM token locking with minimum amount requirements and token burning
 *         • NFT minting with associated brand names and lock data storage
 *         • NFT merging functionality to consolidate locked amounts
 *         • Partial unlock processes via external unlock manager integration
 *         • Cross-chain synchronization for lock data consistency
 *         • Fee collector integration for automatic fee reduction calculations
 *         • Granular pause controls for transfers and contract operations
 *         • Role-based access control for administrative and sync functions
 *         • Comprehensive view functions for user and system queries
 *
 *         Integration points include external unlock manager for time-locked releases,
 *         fee collector contracts for cross-chain fee reduction tracking, and sync
 *         mechanisms for maintaining consistency across multiple blockchain networks.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/// @notice Minimal burnable extension for any ERC‑20 we treat as SYMM.
interface IERC20Burnable is IERC20 {
	function burnFrom(address account, uint256 amount) external;
}

/**
 * @notice Interface for the unlock manager contract handling token unlock processes.
 * @dev Deployed separately to manage unlock operations for locked SYMM tokens.
 */
interface ISymmUnlockManager {
	/**
	 * @notice Initiate the unlock process for a specified NFT.
	 * @param tokenId Token ID of the NFT to unlock.
	 * @param owner   Owner address of the NFT.
	 * @param amount  Amount of tokens to unlock.
	 */
	function initiateUnlock(uint256 tokenId, address owner, uint256 amount) external;

	/**
	 * @notice Check if an NFT is currently in the unlocking process.
	 * @param tokenId Token ID to check.
	 * @return Whether the NFT is being unlocked.
	 */
	function isUnlocking(uint256 tokenId) external view returns (bool);
}

/**
 * @notice Interface for the fee collector contract handling fee collection.
 */
interface ISymmFeeCollector {
	/**
	 * @notice Called when the locked amount of an NFT changes.
	 * @param amount Change in locked amount (positive for increase, negative for decrease).
	 */
	function onLockedAmountChanged(int256 amount) external;
}

contract SymmioBuildersNft is ERC721Enumerable, AccessControlEnumerable, Pausable, ReentrancyGuard {
	using SafeERC20 for IERC20;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for updating configuration parameters like minimum lock amount and unlock manager.
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

	/// @notice The SYMM token contract address (immutable for gas efficiency).
	IERC20Burnable public immutable SYMM;

	/// @notice The unlock manager contract for handling token unlock processes.
	ISymmUnlockManager public unlockManager;

	/// @notice The minimum amount of SYMM tokens required to mint an NFT.
	uint256 public minLockAmount;

	/// @notice Counter for generating unique token IDs sequentially.
	uint256 private _tokenIdCounter;

	/// @notice Flag indicating whether NFT transfers are paused independently of contract pause.
	bool public transfersPaused;

	/// @notice Mapping of token ID to its comprehensive lock data.
	mapping(uint256 => LockData) public lockData;

	/// @notice Mapping of user address to their owned token IDs for internal tracking.
	mapping(address => uint256[]) private _userTokens;

	/// @notice Mapping of token ID to its related fee collector addresses for fee reduction tracking.
	mapping(uint256 => address[]) public tokenRelatedFeeCollectors;

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
	 * @notice Emitted when two NFTs are merged into one.
	 * @param targetTokenId ID of the NFT receiving the merged amount.
	 * @param sourceTokenId ID of the NFT being burned.
	 * @param newAmount     New total locked amount in the target NFT.
	 */
	event TokensMerged(uint256 indexed targetTokenId, uint256 indexed sourceTokenId, uint256 newAmount);

	/**
	 * @notice Emitted when an NFT's brand name is updated.
	 * @param tokenId      ID of the NFT.
	 * @param newBrandName New brand name assigned.
	 */
	event BrandNameUpdated(uint256 indexed tokenId, string newBrandName);

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

	error AmountBelowMinimum(uint256 amount, uint256 minimum); // locked amount below minimum required
	error NotTokenOwner(); // caller is not the owner of the NFT
	error InsufficientLockedAmount(); // requested unlock amount exceeds available locked amount
	error InvalidTokenId(); // invalid token ID provided
	error ZeroAddress(); // zero address provided for critical parameters
	error ZeroAmount(); // zero amount provided for operations requiring non-zero value
	error TransfersPaused(); // NFT transfers are paused
	error UnlockManagerNotSet(); // unlock manager is not set
	error TokenHasActiveUnlock(); // NFT has an active unlock process
	error UnauthorizedAccess(address caller, address requiredCaller); // unauthorized caller attempted restricted action
	error LengthMismatch(); // input arrays have mismatched lengths

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Comprehensive lock data structure for each NFT.
	 * @param amount           Total amount of SYMM tokens locked.
	 * @param lockTimestamp    Timestamp when the tokens were locked.
	 * @param brandName        Custom brand name associated with the NFT.
	 * @param unlockingAmount  Amount of tokens currently being unlocked.
	 */
	struct LockData {
		uint256 amount;
		uint256 lockTimestamp;
		string brandName;
		uint256 unlockingAmount;
	}

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/**
	 * @notice Initialize the SymmioBuildersNft contract with core parameters.
	 * @param _symm           Address of the SYMM token contract.
	 * @param _admin          Address to receive admin and all role assignments.
	 * @param _minLockAmount  Minimum amount of SYMM tokens required to mint an NFT.
	 *
	 * @dev Sets up the ERC721 contract, assigns comprehensive roles, and validates inputs.
	 */
	constructor(address _symm, address _admin, uint256 _minLockAmount) ERC721("Symmio Builders NFT", "BUILDERS") {
		if (_symm == address(0) || _admin == address(0)) revert ZeroAddress();
		if (_minLockAmount == 0) revert ZeroAmount();

		SYMM = IERC20Burnable(_symm);
		minLockAmount = _minLockAmount;

		// Grant all roles to the admin for initial setup
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
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

		// Burn the SYMM tokens by transferring to zero address
		SYMM.burnFrom(msg.sender, amount);

		// Mint new NFT with the next available token ID
		tokenId = _tokenIdCounter++;
		_safeMint(msg.sender, tokenId);

		// Store comprehensive lock data for the NFT
		lockData[tokenId] = LockData({ amount: amount, lockTimestamp: block.timestamp, brandName: brandName, unlockingAmount: 0 });

		// Notify all related fee collectors of the locked amount increase
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[tokenId][i]).onLockedAmountChanged(int256(amount));

		emit TokenLocked(msg.sender, tokenId, amount, brandName);
	}

	/**
	 * @notice Lock additional SYMM tokens into an existing NFT.
	 * @param tokenId ID of the NFT to lock tokens into.
	 * @param amount  Amount of SYMM tokens to lock.
	 *
	 * @dev Burns the SYMM tokens and increases the locked amount for the NFT.
	 */
	function lock(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused {
		if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

		// Burn the SYMM tokens by transferring to zero address
		SYMM.burnFrom(msg.sender, amount);

		// Increase the locked amount for the NFT
		lockData[tokenId].amount += amount;

		// Notify all related fee collectors of the locked amount increase
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[tokenId][i]).onLockedAmountChanged(int256(amount));

		emit TokenLocked(msg.sender, tokenId, amount, lockData[tokenId].brandName);
	}

	/* ────────────────────────── NFT Management ────────────────────────── */

	/**
	 * @notice Merge two NFTs owned by the caller into a single NFT.
	 * @param targetTokenId ID of the NFT to merge into (will receive combined amount).
	 * @param sourceTokenId ID of the NFT to merge from (will be burned).
	 *
	 * @dev Combines locked amounts, burns source NFT, updates target NFT, and notifies fee collectors.
	 *      Reverts if either NFT has an active unlock process.
	 */
	function merge(uint256 targetTokenId, uint256 sourceTokenId) external nonReentrant whenNotPaused {
		if (ownerOf(targetTokenId) != msg.sender) revert NotTokenOwner();
		if (ownerOf(sourceTokenId) != msg.sender) revert NotTokenOwner();

		LockData storage targetData = lockData[targetTokenId];
		LockData storage sourceData = lockData[sourceTokenId];

		if (targetData.unlockingAmount > 0 || sourceData.unlockingAmount > 0) revert TokenHasActiveUnlock();

		// Merge locked amounts into the target NFT
		uint256 newAmount = targetData.amount + sourceData.amount;
		targetData.amount = newAmount;

		// Burn the source NFT and clear its lock data
		_burn(sourceTokenId);
		delete lockData[sourceTokenId];

		// Notify fee collectors for the target NFT (increase)
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[targetTokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[targetTokenId][i]).onLockedAmountChanged(int256(sourceData.amount));

		// Notify fee collectors for the source NFT (decrease)
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[sourceTokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[sourceTokenId][i]).onLockedAmountChanged(-int256(sourceData.amount));

		emit TokensMerged(targetTokenId, sourceTokenId, newAmount);
	}

	/**
	 * @notice Update the brand name of an NFT.
	 * @param tokenId       ID of the NFT to update.
	 * @param newBrandName  New brand name for the NFT.
	 *
	 * @dev Only callable by the NFT owner.
	 */
	function updateBrandName(uint256 tokenId, string memory newBrandName) external {
		if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

		lockData[tokenId].brandName = newBrandName;

		emit BrandNameUpdated(tokenId, newBrandName);
	}

	/* ──────────────────────── Unlock Functions ──────────────────────── */

	/**
	 * @notice Initiate the unlock process for a portion of an NFT's locked tokens.
	 * @param tokenId ID of the NFT to unlock from.
	 * @param amount  Amount of tokens to unlock.
	 *
	 * @dev Updates the unlocking amount, calls the unlock manager, and notifies fee collectors.
	 */
	function initiateUnlock(uint256 tokenId, uint256 amount) external nonReentrant {
		if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
		if (address(unlockManager) == address(0)) revert UnlockManagerNotSet();

		LockData storage data = lockData[tokenId];
		uint256 availableAmount = data.amount - data.unlockingAmount;

		if (amount > availableAmount) revert InsufficientLockedAmount();
		if (amount == 0) revert ZeroAmount();

		// Update the unlocking amount
		data.unlockingAmount += amount;

		// Delegate to the unlock manager
		unlockManager.initiateUnlock(tokenId, msg.sender, amount);

		// Notify fee collectors of the effective decrease in locked amount
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[tokenId][i]).onLockedAmountChanged(-int256(amount));

		emit UnlockInitiated(tokenId, msg.sender, amount);
	}

	/**
	 * @notice Complete the unlock process for an NFT, transferring tokens to the unlock manager.
	 * @param tokenId ID of the NFT to unlock.
	 * @param amount  Amount of tokens being unlocked.
	 *
	 * @dev Only callable by the unlock manager. Burns the NFT if no tokens remain.
	 */
	function completeUnlock(uint256 tokenId, uint256 amount) external {
		if (msg.sender != address(unlockManager)) revert UnauthorizedAccess(msg.sender, address(unlockManager));

		LockData storage data = lockData[tokenId];
		data.unlockingAmount -= amount;
		data.amount -= amount;

		// Burn the NFT if no locked tokens remain
		if (data.amount == 0) {
			_burn(tokenId);
			delete lockData[tokenId];
		}
	}

	/**
	 * @notice Cancel an unlock process for an NFT, restoring the unlocking amount.
	 * @param tokenId ID of the NFT to cancel the unlock for.
	 * @param amount  Amount to cancel from the unlocking process.
	 *
	 * @dev Only callable by the unlock manager. Restores effective locked amount.
	 */
	function cancelUnlock(uint256 tokenId, uint256 amount) external {
		if (msg.sender != address(unlockManager)) revert UnauthorizedAccess(msg.sender, address(unlockManager));

		lockData[tokenId].unlockingAmount -= amount;

		// Notify fee collectors of the effective increase in locked amount
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[tokenId][i]).onLockedAmountChanged(int256(amount));
	}

	/* ───────────────────── Cross-Chain Sync Functions ───────────────────── */

	/**
	 * @notice Mint an NFT without token transfer for cross-chain synchronization.
	 * @param to        Address to mint the NFT to.
	 * @param tokenId   Specific token ID to mint.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param brandName Brand name for the NFT.
	 *
	 * @dev Only callable by accounts with SYNC_ROLE. Used for cross-chain lock data sync.
	 */
	function syncMint(address to, uint256 tokenId, uint256 amount, string memory brandName) external onlyRole(SYNC_ROLE) whenNotPaused {
		// Update token ID counter to avoid conflicts with future mints
		if (tokenId >= _tokenIdCounter) {
			_tokenIdCounter = tokenId + 1;
		}

		// Mint NFT to the specified address
		_safeMint(to, tokenId);

		// Store lock data for the NFT
		lockData[tokenId] = LockData({ amount: amount, lockTimestamp: block.timestamp, brandName: brandName, unlockingAmount: 0 });

		// Notify all related fee collectors of the locked amount
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++)
			ISymmFeeCollector(tokenRelatedFeeCollectors[tokenId][i]).onLockedAmountChanged(int256(amount));

		emit SyncMint(to, tokenId, amount, brandName);
	}

	/**
	 * @notice Update lock data for multiple NFTs for cross-chain synchronization.
	 * @param tokenIds  Array of token IDs to update.
	 * @param lockDatas Array of lock data to apply.
	 *
	 * @dev Only callable by accounts with SYNC_ROLE. Arrays must have matching lengths.
	 */
	function batchUpdateLockData(uint256[] calldata tokenIds, LockData[] calldata lockDatas) external onlyRole(SYNC_ROLE) {
		if (tokenIds.length != lockDatas.length) revert LengthMismatch();

		// Update lock data for each token ID
		for (uint256 i = 0; i < tokenIds.length; i++) {
			uint256 oldAmount = lockData[tokenIds[i]].amount;
			uint256 newAmount = lockDatas[i].amount;
			lockData[tokenIds[i]] = lockDatas[i];

			// Notify all related fee collectors of the locked amount
			for (uint256 j = 0; j < tokenRelatedFeeCollectors[tokenIds[i]].length; j++)
				ISymmFeeCollector(tokenRelatedFeeCollectors[tokenIds[i]][j]).onLockedAmountChanged(int256(newAmount) - int256(oldAmount));
		}
	}

	/* ───────────────────────── Pause Controls ───────────────────────── */

	/**
	 * @notice Pause the contract, disabling state-changing functions.
	 * @dev Only callable by accounts with PAUSER_ROLE.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpause the contract, enabling state-changing functions.
	 * @dev Only callable by accounts with UNPAUSER_ROLE.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/**
	 * @notice Set the pause state for NFT transfers independently of contract pause.
	 * @param _paused True to pause transfers, false to unpause.
	 *
	 * @dev Only callable by accounts with TRANSFER_PAUSER_ROLE.
	 */
	function setTransfersPaused(bool _paused) external onlyRole(TRANSFER_PAUSER_ROLE) {
		transfersPaused = _paused;
		emit TransfersPausedUpdated(_paused);
	}

	/* ────────────────────────── Admin Functions ────────────────────────── */

	/**
	 * @notice Set the minimum lock amount for minting NFTs.
	 * @param _minLockAmount New minimum lock amount.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE.
	 */
	function setMinLockAmount(uint256 _minLockAmount) external onlyRole(SETTER_ROLE) {
		if (_minLockAmount == 0) revert ZeroAmount();
		minLockAmount = _minLockAmount;
		emit MinLockAmountUpdated(_minLockAmount);
	}

	/**
	 * @notice Set the address of the unlock manager contract.
	 * @param _unlockManager New unlock manager address.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE.
	 */
	function setUnlockManager(address _unlockManager) external onlyRole(SETTER_ROLE) {
		if (_unlockManager == address(0)) revert ZeroAddress();
		unlockManager = ISymmUnlockManager(_unlockManager);
		emit UnlockManagerUpdated(_unlockManager);
	}

	/**
	 * @notice Add fee collectors to an NFT for fee reduction tracking.
	 * @param tokenId       ID of the NFT to add fee collectors to.
	 * @param feeCollectors Array of fee collector addresses to add.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE.
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
	 *
	 * @dev Only callable by accounts with SETTER_ROLE. Uses swap-and-pop for gas efficiency.
	 */
	function removeFeeCollector(uint256 tokenId, address feeCollector) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < tokenRelatedFeeCollectors[tokenId].length; i++) {
			if (tokenRelatedFeeCollectors[tokenId][i] == feeCollector) {
				tokenRelatedFeeCollectors[tokenId][i] = tokenRelatedFeeCollectors[tokenId][tokenRelatedFeeCollectors[tokenId].length - 1];
				tokenRelatedFeeCollectors[tokenId].pop();
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
	 * @notice Get all token IDs owned by a user.
	 * @param user Address of the user.
	 * @return Array of token IDs owned by the user.
	 */
	function getUserTokenIds(address user) external view returns (uint256[] memory) {
		uint256 balance = balanceOf(user);
		uint256[] memory tokenIds = new uint256[](balance);
		for (uint256 i = 0; i < balance; i++) {
			tokenIds[i] = tokenOfOwnerByIndex(user, i);
		}
		return tokenIds;
	}

	/**
	 * @notice Get the total effective locked amount for a user across all their NFTs.
	 * @param user Address of the user.
	 * @return total Total effective locked amount for fee reduction calculations.
	 */
	function getUserTotalLocked(address user) external view returns (uint256 total) {
		uint256 balance = balanceOf(user);
		for (uint256 i = 0; i < balance; i++) {
			uint256 tokenId = tokenOfOwnerByIndex(user, i);
			LockData storage data = lockData[tokenId];
			total += (data.amount - data.unlockingAmount);
		}
	}

	/* ───────────────────────── Internal Helpers ───────────────────────── */

	/**
	 * @dev Override ERC721 update function to enforce transfer restrictions.
	 * @param to      Address to transfer to (address(0) for burns).
	 * @param tokenId ID of the NFT being updated.
	 * @param auth    Address authorized for the update.
	 * @return        Address of the previous owner.
	 *
	 * @dev Prevents transfers if paused or if the NFT has an active unlock process.
	 *      Allows minting (from == address(0)) and burning (to == address(0)).
	 */
	function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
		address from = _ownerOf(tokenId);

		// Allow minting (from == address(0)) and burning (to == address(0))
		// Only restrict actual transfers between addresses
		if (from != address(0) && to != address(0)) {
			if (transfersPaused) revert TransfersPaused();
			if (lockData[tokenId].unlockingAmount > 0) revert TokenHasActiveUnlock();
		}

		return super._update(to, tokenId, auth);
	}

	/* ──────────────────── Interface Support ──────────────────── */

	/**
	 * @notice Check if the contract supports a given interface.
	 * @param interfaceId Interface ID to check.
	 * @return Whether the interface is supported.
	 *
	 * @dev Supports both ERC721Enumerable and AccessControlEnumerable interfaces.
	 */
	function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable, AccessControlEnumerable) returns (bool) {
		return super.supportsInterface(interfaceId);
	}
}
