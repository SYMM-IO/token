// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmioBuildersNftManager
 * @notice Comprehensive manager contract for SymmioBuildersNft that handles all complex logic
 *         including SYMM token locking, unlock processes with cliff and vesting, merging,
 *         fee collection, and cross-chain sync. Integrates full VestingV2 functionality.
 *
 * @dev    Core features include:
 *         • SYMM token locking with burning and without burning (for MINTER_ROLE)
 *         • Lock data management for all NFTs
 *         • NFT merging functionality
 *         • Time-locked unlock functionality with cliff periods
 *         • Full VestingV2 functionality (linear vesting, penalties, percentage claims)
 *         • Unlock request management with unique ID tracking
 *         • Fee collector management and notifications
 *         • Cross-chain synchronization capabilities
 *         • Transfer restrictions based on unlock status
 *         • Token minting capabilities for vesting operations
 *
 *         This contract acts as the central logic hub while the NFT contract remains simple.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../vesting/VestingV2.sol";
import "./interfaces/ISymmioBuildersNft.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/// @notice Minimal burnable extension for any ERC‑20 we treat as SYMM.
interface IERC20Burnable is IERC20 {
	function burnFrom(address account, uint256 amount) external;
}

/// @notice Minimal mintable extension for SYMM token.
interface IERC20Mintable is IERC20 {
	function mint(address to, uint256 amount) external;
}

/**
 * @notice Interface for the fee collector contract handling fee collection.
 */
interface ISymmFeeCollector {
	function onLockedAmountChanged(int256 amount) external;
}

contract SymmioBuildersNftManager is VestingV2 {
	using SafeERC20 for IERC20;

	/* ─────────────────────────────── Additional Roles ─────────────────────────────── */

	/// @notice Role for minting NFTs without burning SYMM tokens.
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	/// @notice Role for syncing cross-chain lock data and minting NFTs.
	bytes32 public constant SYNC_ROLE = keccak256("SYNC_ROLE");

	/// @notice Role for updating cliff and vesting durations.
	bytes32 public constant DURATION_SETTER_ROLE = keccak256("DURATION_SETTER_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice The SYMM token contract address (burnable and mintable).
	IERC20Burnable public SYMM;

	/// @notice The SymmioBuildersNft contract.
	ISymmioBuildersNft public nftContract;

	/// @notice The minimum amount of SYMM tokens required to mint an NFT.
	uint256 public minLockAmount;

	/// @notice Duration of the cliff period in seconds before tokens can be unlocked.
	uint256 public cliffDuration;

	/// @notice Duration of the vesting period in seconds after cliff completion.
	uint256 public vestingDuration;

	/// @notice Counter for generating unique unlock request IDs sequentially.
	uint256 private _unlockIdCounter;

	/// @notice Mapping of token ID to its related fee collector addresses.
	mapping(uint256 => address[]) public tokenRelatedFeeCollectors;

	/// @notice Mapping of unlock request ID to complete request details.
	mapping(uint256 => UnlockRequest) public unlockRequests;

	/// @notice Mapping of NFT token ID to array of associated unlock request IDs.
	mapping(uint256 => uint256[]) public tokenUnlockIds;

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Complete details of an unlock request with status tracking.
	 * @param amount               Amount of tokens to unlock.
	 * @param unlockInitiatedTime  Timestamp when unlock was initiated.
	 * @param owner                Owner of the NFT at unlock initiation.
	 * @param tokenId              ID of the NFT being unlocked.
	 * @param cliffPassed          Whether the cliff period has passed.
	 * @param vestingStarted       Whether vesting has started for this request.
	 * @param vestingPlanId        ID of the created vesting plan in VestingV2.
	 */
	struct UnlockRequest {
		uint256 amount;
		uint256 unlockInitiatedTime;
		address owner;
		uint256 tokenId;
		bool cliffPassed;
		bool vestingStarted;
		uint256 vestingPlanId;
	}

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
	 * @param unlockId      ID of the unlock request.
	 * @param tokenId       ID of the NFT.
	 * @param owner         Owner of the NFT.
	 * @param amount        Amount of tokens to unlock.
	 * @param cliffEndTime  Timestamp when the cliff period ends.
	 */
	event UnlockInitiated(uint256 indexed unlockId, uint256 indexed tokenId, address indexed owner, uint256 amount, uint256 cliffEndTime);

	/**
	 * @notice Emitted when an unlock process is cancelled.
	 * @param unlockId ID of the unlock request.
	 * @param tokenId  ID of the NFT.
	 * @param owner    Owner of the NFT.
	 * @param amount   Amount of tokens cancelled.
	 */
	event UnlockCancelled(uint256 indexed unlockId, uint256 indexed tokenId, address indexed owner, uint256 amount);

	/**
	 * @notice Emitted when the cliff period for an unlock request is completed.
	 * @param unlockId ID of the unlock request.
	 * @param tokenId  ID of the NFT.
	 * @param owner    Owner of the NFT.
	 */
	event CliffCompleted(uint256 indexed unlockId, uint256 indexed tokenId, address indexed owner);

	/**
	 * @notice Emitted when vesting starts for an unlock request.
	 * @param unlockId       ID of the unlock request.
	 * @param vestingPlanId  ID of the created vesting plan.
	 * @param tokenId        ID of the NFT.
	 * @param owner          Owner of the NFT.
	 * @param amount         Amount of tokens entering vesting.
	 */
	event VestingStarted(uint256 indexed unlockId, uint256 indexed vestingPlanId, uint256 indexed tokenId, address owner, uint256 amount);

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
	 * @notice Emitted when the cliff duration is updated.
	 * @param newDuration New cliff duration in seconds.
	 */
	event CliffDurationUpdated(uint256 newDuration);

	/**
	 * @notice Emitted when the vesting duration is updated.
	 * @param newDuration New vesting duration in seconds.
	 */
	event VestingDurationUpdated(uint256 newDuration);

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
	error ZeroAmount();
	error TokenHasActiveUnlock();
	error UnauthorizedAccess(address caller, address requiredCaller);
	error LengthMismatch();
	error UnlockNotFound();
	error CliffNotPassed();
	error VestingAlreadyStarted();
	error InvalidDuration();

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the SymmioBuildersNftManager contract with full unlock and vesting functionality.
	 * @param _symm                         Address of the SYMM token contract.
	 * @param _nftContract                  Address of the SymmioBuildersNft contract.
	 * @param _admin                        Address to receive admin and all role assignments.
	 * @param _minLockAmount                Minimum amount of SYMM tokens required to mint an NFT.
	 * @param _cliffDuration                Duration of the cliff period in seconds.
	 * @param _vestingDuration              Duration of the vesting period in seconds.
	 * @param _lockedClaimPenalty           Penalty rate for early claims (scaled by 1e18).
	 * @param _lockedClaimPenaltyReceiver   Address to receive penalties from early claims.
	 */
	function initialize(
		address _symm,
		address _nftContract,
		address _admin,
		uint256 _minLockAmount,
		uint256 _cliffDuration,
		uint256 _vestingDuration,
		uint256 _lockedClaimPenalty,
		address _lockedClaimPenaltyReceiver
	) public initializer {
		if (_symm == address(0) || _nftContract == address(0) || _admin == address(0)) revert ZeroAddress();
		if (_minLockAmount == 0) revert ZeroAmount();
		if (_cliffDuration == 0 || _vestingDuration == 0) revert InvalidDuration();
		if (_lockedClaimPenaltyReceiver == address(0)) revert ZeroAddress();

		// Initialize parent VestingV2 contract
		__vesting_init(_admin, _lockedClaimPenalty, _lockedClaimPenaltyReceiver);

		// Set contract-specific state
		SYMM = IERC20Burnable(_symm);
		nftContract = ISymmioBuildersNft(_nftContract);
		minLockAmount = _minLockAmount;
		cliffDuration = _cliffDuration;
		vestingDuration = _vestingDuration;

		// Initialize counter
		_unlockIdCounter = 0;

		// Grant additional roles to the admin for initial setup
		_grantRole(MINTER_ROLE, _admin);
		_grantRole(SYNC_ROLE, _admin);
		_grantRole(DURATION_SETTER_ROLE, _admin);
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
	function initiateUnlock(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused {
		if (nftContract.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		uint256 availableAmount = data.amount - data.unlockingAmount;

		if (amount > availableAmount) revert InsufficientLockedAmount();
		if (amount == 0) revert ZeroAmount();

		// Update the unlocking amount
		nftContract.updateLockData(tokenId, data.amount, data.unlockingAmount + amount, data.name);

		// Create unlock request
		uint256 unlockId = _unlockIdCounter++;
		unlockRequests[unlockId] = UnlockRequest({
			amount: amount,
			unlockInitiatedTime: block.timestamp,
			owner: msg.sender,
			tokenId: tokenId,
			cliffPassed: false,
			vestingStarted: false,
			vestingPlanId: 0
		});

		tokenUnlockIds[tokenId].push(unlockId);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, -int256(amount));

		emit UnlockInitiated(unlockId, tokenId, msg.sender, amount, block.timestamp + cliffDuration);
	}

	/**
	 * @notice Cancel an unlock request before the cliff period ends.
	 * @param unlockId ID of the unlock request to cancel.
	 *
	 * @dev Removes the unlock request and updates NFT contract.
	 *      Only callable by the NFT owner and only before cliff completion.
	 */
	function cancelUnlock(uint256 unlockId) external nonReentrant whenNotPaused {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) revert UnlockNotFound();
		if (request.owner != msg.sender) revert NotTokenOwner();
		if (request.cliffPassed) revert CliffNotPassed();

		uint256 amount = request.amount;
		uint256 tokenId = request.tokenId;
		address owner = request.owner;

		// Clean up unlock request
		delete unlockRequests[unlockId];

		// Remove unlock ID from token's unlock list
		uint256[] storage unlockIds = tokenUnlockIds[tokenId];
		for (uint256 i = 0; i < unlockIds.length; i++) {
			if (unlockIds[i] == unlockId) {
				unlockIds[i] = unlockIds[unlockIds.length - 1];
				unlockIds.pop();
				break;
			}
		}

		// Update NFT contract to cancel the unlock
		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		nftContract.updateLockData(tokenId, data.amount, data.unlockingAmount - amount, data.name);

		// Notify fee collectors
		_notifyFeeCollectors(tokenId, int256(amount));

		emit UnlockCancelled(unlockId, tokenId, owner, amount);
	}

	/**
	 * @notice Complete the cliff period and start vesting for an unlock request.
	 * @param unlockId ID of the unlock request to process.
	 *
	 * @dev Uses inherited VestingV2 functionality to create a sophisticated vesting plan.
	 *      Only callable by NFT owner after cliff period completion.
	 */
	function completeCliffAndStartVesting(uint256 unlockId) external nonReentrant whenNotPaused {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) revert UnlockNotFound();
		if (request.owner != msg.sender) revert NotTokenOwner();
		if (request.vestingStarted) revert VestingAlreadyStarted();
		if (block.timestamp < request.unlockInitiatedTime + cliffDuration) revert CliffNotPassed();

		// Mark cliff as passed and vesting as started
		request.cliffPassed = true;
		request.vestingStarted = true;

		// Complete unlock on NFT contract
		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(request.tokenId);
		nftContract.updateLockData(request.tokenId, data.amount - request.amount, data.unlockingAmount - request.amount, data.name);

		// Burn the NFT if no locked tokens remain
		if (data.amount - request.amount == 0) {
			nftContract.burn(request.tokenId);
		}

		// Create vesting plan using inherited VestingV2 functionality
		address[] memory users = new address[](1);
		users[0] = request.owner;
		uint256[] memory amounts = new uint256[](1);
		amounts[0] = request.amount;

		uint256[] memory planIds = _setupVestingPlans(address(SYMM), block.timestamp, block.timestamp + vestingDuration, users, amounts);

		// Link vesting plan to unlock request
		request.vestingPlanId = planIds[0];

		emit CliffCompleted(unlockId, request.tokenId, request.owner);
		emit VestingStarted(unlockId, planIds[0], request.tokenId, request.owner, request.amount);
		emit UnlockCompleted(request.tokenId, request.owner, request.amount);
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
	 * @notice Update the cliff duration for new unlock requests.
	 * @param _cliffDuration New cliff duration in seconds.
	 *
	 * @dev Only callable by accounts with DURATION_SETTER_ROLE. Must be non-zero.
	 */
	function setCliffDuration(uint256 _cliffDuration) external onlyRole(DURATION_SETTER_ROLE) {
		if (_cliffDuration == 0) revert InvalidDuration();
		cliffDuration = _cliffDuration;
		emit CliffDurationUpdated(_cliffDuration);
	}

	/**
	 * @notice Update the vesting duration for new vesting plans.
	 * @param _vestingDuration New vesting duration in seconds.
	 *
	 * @dev Only callable by accounts with DURATION_SETTER_ROLE. Must be non-zero.
	 */
	function setVestingDuration(uint256 _vestingDuration) external onlyRole(DURATION_SETTER_ROLE) {
		if (_vestingDuration == 0) revert InvalidDuration();
		vestingDuration = _vestingDuration;
		emit VestingDurationUpdated(_vestingDuration);
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

	/**
	 * @notice Get all unlock request IDs for a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @return Array of unlock request IDs associated with the NFT.
	 */
	function getTokenUnlockIds(uint256 tokenId) external view returns (uint256[] memory) {
		return tokenUnlockIds[tokenId];
	}

	/**
	 * @notice Get active unlock requests for a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @return Array of active UnlockRequest structs (excluding completed/vesting requests).
	 *
	 * @dev Filters out requests that have started vesting or been completed.
	 */
	function getActiveUnlockRequests(uint256 tokenId) external view returns (UnlockRequest[] memory) {
		uint256[] memory unlockIds = tokenUnlockIds[tokenId];
		uint256 activeCount = 0;

		// Count active requests (non-zero amount and not vesting)
		for (uint256 i = 0; i < unlockIds.length; i++) {
			if (unlockRequests[unlockIds[i]].amount > 0 && !unlockRequests[unlockIds[i]].vestingStarted) {
				activeCount++;
			}
		}

		// Populate active requests array
		UnlockRequest[] memory activeRequests = new UnlockRequest[](activeCount);
		uint256 index = 0;
		for (uint256 i = 0; i < unlockIds.length; i++) {
			UnlockRequest storage request = unlockRequests[unlockIds[i]];
			if (request.amount > 0 && !request.vestingStarted) {
				activeRequests[index++] = request;
			}
		}

		return activeRequests;
	}

	/**
	 * @notice Check if an NFT has any active unlock requests.
	 * @param tokenId ID of the NFT to check.
	 * @return Whether the NFT has active unlock requests.
	 */
	function isUnlocking(uint256 tokenId) external view returns (bool) {
		uint256[] memory unlockIds = tokenUnlockIds[tokenId];
		for (uint256 i = 0; i < unlockIds.length; i++) {
			UnlockRequest storage request = unlockRequests[unlockIds[i]];
			if (request.amount > 0 && !request.vestingStarted) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @notice Get the cliff end time for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return Timestamp when the cliff period ends, or 0 if request is invalid.
	 */
	function getCliffEndTime(uint256 unlockId) external view returns (uint256) {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) {
			return 0;
		}
		return request.unlockInitiatedTime + cliffDuration;
	}

	/**
	 * @notice Check if the cliff period has passed for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return Whether the cliff period has passed.
	 */
	function isCliffPassed(uint256 unlockId) external view returns (bool) {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) {
			return false;
		}
		return block.timestamp >= request.unlockInitiatedTime + cliffDuration;
	}

	/**
	 * @notice Get the time remaining in the cliff period for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return Seconds remaining until cliff period ends, or 0 if passed/invalid.
	 */
	function getCliffTimeRemaining(uint256 unlockId) external view returns (uint256) {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) {
			return 0;
		}

		uint256 cliffEndTime = request.unlockInitiatedTime + cliffDuration;
		if (block.timestamp >= cliffEndTime) {
			return 0;
		}

		return cliffEndTime - block.timestamp;
	}

	/**
	 * @notice Get the vesting plan ID for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return vestingPlanId ID of the associated vesting plan (0 if not started).
	 */
	function getUnlockVestingPlanId(uint256 unlockId) external view returns (uint256 vestingPlanId) {
		UnlockRequest storage request = unlockRequests[unlockId];
		return request.vestingPlanId;
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
	 * @notice Override to handle SYMM token minting when needed for vesting.
	 * @param token  Address of the token to mint.
	 * @param amount Amount of tokens to mint.
	 *
	 * @dev This function mints SYMM tokens when the contract needs more tokens for vesting operations.
	 */
	function _mintTokenIfPossible(address token, uint256 amount) internal virtual override {
		if (token == address(SYMM)) {
			IERC20Mintable(address(SYMM)).mint(address(this), amount);
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
