// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmioBuildersNftManager
 * @notice Comprehensive manager contract for SymmioBuildersNft that handles all complex logic
 *         including SYMM token locking, unlock processes with cliff and vesting, merging,
 *         and cross-chain sync. Integrates full Vesting functionality.
 *
 * @dev    Core features include:
 *         • SYMM token locking with burning and without burning (for MINTER_ROLE)
 *         • Lock data management for all NFTs
 *         • NFT merging functionality
 *         • Time-locked unlock functionality with cliff periods
 *         • Full Vesting functionality (linear vesting, penalties, percentage claims)
 *         • Unlock request management with unique ID tracking
 *         • Cross-chain synchronization capabilities
 *         • Transfer restrictions based on unlock status
 *         • Token minting capabilities for vesting operations
 *
 *         This contract acts as the central logic hub while the NFT contract remains simple.
 */

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Flow, VestingFlowLib } from "./libraries/VestingFlowLib.sol";
import { ISymmioBuildersNft } from "./interfaces/ISymmioBuildersNft.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/// @notice Minimal burnable and mintable extension for any ERC‑20.
interface IERC20Extended is IERC20 {
	function burnFrom(address account, uint256 amount) external;

	function mint(address to, uint256 amount) external;
}

contract SymmioBuildersNftManager is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20Extended;
	using VestingFlowLib for Flow;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for setting configs.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for claiming tokens on behalf of users.
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	/// @notice Role for pausing contract operations.
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing contract operations.
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/// @notice Role for minting NFTs without burning SYMM tokens.
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	/// @notice Role for syncing cross-chain lock data and minting NFTs.
	bytes32 public constant SYNC_ROLE = keccak256("SYNC_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice The SYMM token contract address (burnable and mintable).
	IERC20Extended public SYMM;

	/// @notice The SymmioBuildersNft contract.
	ISymmioBuildersNft public nftContract;

	/// @notice The minimum amount of SYMM tokens required to mint an NFT.
	uint256 public minLockAmount;

	/// @notice Duration of the cliff period in seconds before tokens can be unlocked.
	uint256 public cliffDuration;

	/// @notice Duration of the vesting period in seconds after cliff completion.
	uint256 public vestingDuration;

	/// @notice Penalty rate for claiming locked tokens early (scaled by 1e18).
	/// @dev Example: 0.1e18 represents a 10% penalty on early claims.
	uint256 public lockedClaimPenaltyRate;

	/// @notice Address that receives penalties from early claims of locked tokens.
	address public lockedClaimPenaltyReceiver;

	/// @notice Counter for generating unique unlock request IDs sequentially.
	uint256 private _unlockIdCounter;

	/// @notice Total vested amount that not claimed yet across all flows.
	uint256 public totalVested;

	/// @notice Mapping of unlock request ID to complete request details.
	mapping(uint256 => UnlockRequest) public unlockRequests;

	/// @notice Mapping of NFT token ID to array of associated unlock request IDs.
	mapping(uint256 => uint256[]) public tokenUnlockIds;

	uint256 private _nextFlowId;
	mapping(uint256 => Flow) private _flows;
	mapping(address => uint256[]) private _userFlowIds;

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Complete details of an unlock request with status tracking.
	 * @param amount               Amount of tokens to unlock.
	 * @param unlockInitiatedTime  Timestamp when unlock was initiated.
	 * @param owner                Owner of the NFT at unlock initiation.
	 * @param tokenId              ID of the NFT being unlocked.
	 * @param cliffPassed          Whether the cliff period has passed.
	 * @param vestingStarted       Whether vesting has started for this request.
	 * @param vestingFlowId        ID of the created vesting flow.
	 */
	struct UnlockRequest {
		uint256 amount;
		uint256 unlockInitiatedTime;
		address owner;
		uint256 tokenId;
		bool vestingStarted;
		uint256 vestingFlowId;
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
	 * @notice Emitted when vesting starts for an unlock request.
	 * @param unlockId       ID of the unlock request.
	 * @param tokenId        ID of the NFT.
	 * @param vestingFlowId  ID of the created vesting flow.
	 * @param owner          Owner of the NFT.
	 * @param amount         Amount of tokens entering vesting.
	 */
	event VestingStarted(uint256 indexed unlockId, uint256 indexed tokenId, address owner, uint256 amount, uint256 vestingFlowId);

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
	 * @notice Emitted when unlocked tokens are claimed from a vesting flow.
	 * @param user   Address of the user claiming the tokens.
	 * @param flowId ID of the vesting flow.
	 * @param amount Amount of tokens claimed.
	 */
	event UnlockedTokenClaimed(address indexed user, uint256 indexed flowId, uint256 amount);

	/**
	 * @notice Emitted when locked tokens are claimed with a penalty.
	 * @param user    Address of the user claiming the tokens.
	 * @param flowId  ID of the vesting flow.
	 * @param amount  Total amount of tokens claimed (before penalty).
	 * @param penalty Penalty amount deducted from the claim.
	 */
	event LockedTokenClaimed(address indexed user, uint256 indexed flowId, uint256 amount, uint256 penalty);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error ZeroAddress();
	error AmountBelowMinimum(uint256 amount, uint256 minimum);
	error NotTokenOwner();
	error InsufficientLockedAmount();
	error InvalidMerge();
	error ZeroAmount();
	error TokenHasActiveUnlock();
	error LengthMismatch();
	error UnlockNotFound();
	error CliffNotPassed();
	error VestingAlreadyStarted();
	error InvalidDuration();
	error InvalidPenalty(uint256 penalty);
	error NotOwner();

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
	 * @param _lockedClaimPenaltyRate       Penalty rate for early claims (scaled by 1e18).
	 * @param _lockedClaimPenaltyReceiver   Address to receive penalties from early claims.
	 */
	function initialize(
		address _symm,
		address _nftContract,
		address _admin,
		uint256 _minLockAmount,
		uint256 _cliffDuration,
		uint256 _vestingDuration,
		uint256 _lockedClaimPenaltyRate,
		address _lockedClaimPenaltyReceiver
	) public initializer {
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		if (_symm == address(0) || _nftContract == address(0) || _admin == address(0) || _lockedClaimPenaltyReceiver == address(0))
			revert ZeroAddress();
		if (_cliffDuration == 0 || _vestingDuration == 0) revert InvalidDuration();
		if (_lockedClaimPenaltyRate > 1e18) revert InvalidPenalty(_lockedClaimPenaltyRate);

		// Set contract-specific state
		SYMM = IERC20Extended(_symm);
		nftContract = ISymmioBuildersNft(_nftContract);
		minLockAmount = _minLockAmount;
		cliffDuration = _cliffDuration;
		vestingDuration = _vestingDuration;
		lockedClaimPenaltyRate = _lockedClaimPenaltyRate;
		lockedClaimPenaltyReceiver = _lockedClaimPenaltyReceiver;

		// Grant all roles to the admin
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);
		_grantRole(OPERATOR_ROLE, _admin);
		_grantRole(MINTER_ROLE, _admin);
		_grantRole(SYNC_ROLE, _admin);
	}

	/* ────────────────────── Pausing Functions ────────────────────── */

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

	/* ────────────────────── Core NFT & Locking Functions ────────────────────── */

	/**
	 * @notice Mint an NFT by locking SYMM tokens with a custom brand name.
	 * @param amount    Amount of SYMM tokens to lock (must meet minimum requirement).
	 * @param brandName Custom brand name for the NFT.
	 * @return tokenId  ID of the newly minted NFT.
	 *
	 * @dev Burns the SYMM tokens, mints an NFT, and stores lock data.
	 */
	function mintAndLock(uint256 amount, string memory brandName) external nonReentrant whenNotPaused returns (uint256 tokenId) {
		if (amount < minLockAmount) revert AmountBelowMinimum(amount, minLockAmount);

		// Burn the SYMM tokens
		SYMM.burnFrom(msg.sender, amount);

		// Mint new NFT
		tokenId = nftContract.mint(msg.sender, amount, brandName);

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
		if (to == address(0)) revert ZeroAddress();

		// Mint new NFT
		tokenId = nftContract.mint(to, amount, brandName);

		emit NFTMintedWithoutBurn(msg.sender, to, tokenId, amount, brandName);
	}

	/**
	 * @notice Lock additional SYMM tokens into an existing NFT.
	 * @param tokenId ID of the NFT to lock tokens into.
	 * @param amount  Amount of SYMM tokens to lock.
	 */
	function lockIntoNFT(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused {
		if (amount == 0) revert ZeroAmount();
		if (nftContract.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

		// Burn the SYMM tokens
		SYMM.burnFrom(msg.sender, amount);

		// Increase the locked amount
		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		nftContract.updateLockData(tokenId, data.amount + amount, data.unlockingAmount, data.name);

		emit TokenLocked(msg.sender, tokenId, amount);
	}

	/* ────────────────────────── NFT Management ────────────────────────── */

	/**
	 * @notice Merge two NFTs owned by the caller into a single NFT.
	 * @param targetTokenId ID of the NFT to merge into (will receive combined amount).
	 * @param sourceTokenId ID of the NFT to merge from (will be burned).
	 */
	function merge(uint256 targetTokenId, uint256 sourceTokenId) external nonReentrant whenNotPaused {
		if (nftContract.ownerOf(targetTokenId) != msg.sender || nftContract.ownerOf(sourceTokenId) != msg.sender) revert NotTokenOwner();
		if (targetTokenId == sourceTokenId) revert InvalidMerge();

		ISymmioBuildersNft.LockData memory targetData = nftContract.getLockData(targetTokenId);
		ISymmioBuildersNft.LockData memory sourceData = nftContract.getLockData(sourceTokenId);

		if (sourceData.unlockingAmount > 0) revert TokenHasActiveUnlock();

		// Merge locked amounts
		uint256 newAmount = targetData.amount + sourceData.amount;
		nftContract.updateLockData(targetTokenId, newAmount, targetData.unlockingAmount, targetData.name);

		// Burn the source NFT and clear its data
		nftContract.burn(sourceTokenId);

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
		if (amount == 0) revert ZeroAmount();

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(tokenId);
		uint256 availableAmount = data.amount - data.unlockingAmount;

		if (amount > availableAmount) revert InsufficientLockedAmount();

		// Update the unlocking amount
		nftContract.updateLockData(tokenId, data.amount, data.unlockingAmount + amount, data.name);

		// Create unlock request
		uint256 unlockId = _unlockIdCounter++;
		unlockRequests[unlockId] = UnlockRequest({
			amount: amount,
			unlockInitiatedTime: block.timestamp,
			owner: msg.sender,
			tokenId: tokenId,
			vestingStarted: false,
			vestingFlowId: 0
		});

		tokenUnlockIds[tokenId].push(unlockId);

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
		UnlockRequest memory request = unlockRequests[unlockId];
		if (request.amount == 0) revert UnlockNotFound();
		if (request.owner != msg.sender) revert NotTokenOwner();
		if (request.vestingStarted) revert VestingAlreadyStarted();

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

		emit UnlockCancelled(unlockId, tokenId, owner, amount);
	}

	/**
	 * @notice Complete the cliff period and start vesting for an unlock request.
	 * @param unlockId ID of the unlock request to process.
	 */
	function completeCliffAndStartVesting(uint256 unlockId) external nonReentrant whenNotPaused {
		UnlockRequest memory request = unlockRequests[unlockId];
		if (request.amount == 0) revert UnlockNotFound();
		if (request.owner != msg.sender) revert NotTokenOwner();
		if (request.vestingStarted) revert VestingAlreadyStarted();
		uint256 startTime = request.unlockInitiatedTime + cliffDuration;
		if (block.timestamp < startTime) revert CliffNotPassed();

		// Mark vesting as started
		unlockRequests[unlockId].vestingStarted = true;

		ISymmioBuildersNft.LockData memory data = nftContract.getLockData(request.tokenId);
		uint256 newAmount = data.amount - request.amount;
		uint256 newUnlockingAmount = data.unlockingAmount - request.amount;

		// Complete unlock on NFT contract
		nftContract.updateLockData(request.tokenId, newAmount, newUnlockingAmount, data.name);

		// Burn the NFT if no locked tokens remain
		if (newAmount == 0 && newUnlockingAmount == 0) nftContract.burn(request.tokenId);

		// Create vesting flow
		uint256 flowId = _nextFlowId++;
		_flows[flowId] = Flow({ owner: request.owner, amount: request.amount, startTime: startTime, endTime: startTime + vestingDuration });
		_userFlowIds[request.owner].push(flowId);
		totalVested += request.amount;

		// Link vesting flow to unlock request
		unlockRequests[unlockId].vestingFlowId = flowId;

		emit VestingStarted(unlockId, request.tokenId, request.owner, request.amount, flowId);
	}

	/* ───────────────── Token Claim Functions ───────────────── */

	/**
	 * @notice Claim unlocked tokens for the caller from a specific vesting flow.
	 * @param flowId ID of the vesting flow.
	 *
	 * @dev Claims only fully vested tokens without penalty.
	 */
	function claimUnlockedToken(uint256 flowId) external whenNotPaused nonReentrant returns (uint256 unlockedClaimed) {
		(, unlockedClaimed) = _claimUnlockedToken(msg.sender, flowId);
	}

	/**
	 * @notice Claim unlocked tokens on behalf of a user from a specific vesting flow.
	 * @param user   Address of the user to claim for.
	 * @param flowId ID of the vesting flow.
	 *
	 * @dev Only callable by accounts with OPERATOR_ROLE.
	 */
	function claimUnlockedTokenFor(
		address user,
		uint256 flowId
	) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant returns (uint256 unlockedClaimed) {
		(, unlockedClaimed) = _claimUnlockedToken(user, flowId);
	}

	/**
	 * @notice Claim locked tokens for the caller with penalty deduction.
	 * @param flowId ID of the vesting flow.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Claims unlocked tokens first, then processes locked amount with penalty.
	 */
	function claimLockedToken(
		uint256 flowId,
		uint256 amount
	) external whenNotPaused nonReentrant returns (uint256 unlockedClaimed, uint256 lockedClaimed, uint256 penalty) {
		(unlockedClaimed, lockedClaimed, penalty) = _claimLockedToken(msg.sender, flowId, amount);
	}

	/**
	 * @notice Claim locked tokens on behalf of a user with penalty deduction.
	 * @param user   Address of the user to claim for.
	 * @param flowId ID of the vesting flow.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Only callable by accounts with OPERATOR_ROLE.
	 */
	function claimLockedTokenFor(
		address user,
		uint256 flowId,
		uint256 amount
	) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant returns (uint256 unlockedClaimed, uint256 lockedClaimed, uint256 penalty) {
		(unlockedClaimed, lockedClaimed, penalty) = _claimLockedToken(user, flowId, amount);
	}

	/**
	 * @dev Internal function to claim unlocked tokens from a vesting flow.
	 * @param user   Address of the user claiming tokens.
	 * @param flowId ID of the vesting flow.
	 *
	 * @dev Transfers claimable tokens and updates flow state and total vested amounts.
	 */
	function _claimUnlockedToken(address user, uint256 flowId) internal returns (bool flowDeleted, uint256 unlockedAmount) {
		Flow storage flow = _flows[flowId];
		if (flow.owner != user) revert NotOwner();
		unlockedAmount = flow.unlocked();
		if (unlockedAmount > 0) {
			// Update vesting flow and total vested amount
			totalVested -= unlockedAmount;
			flowDeleted = flow.shrink();
			if (flowDeleted) _removeUserFlowId(user, flowId);

			// Ensure sufficient balance before transfer
			_ensureSufficientBalance(unlockedAmount);
			SYMM.safeTransfer(user, unlockedAmount);
			emit UnlockedTokenClaimed(user, flowId, unlockedAmount);
		}
	}

	/**
	 * @dev Internal function to claim locked tokens with penalty deduction.
	 * @param user   Address of the user claiming tokens.
	 * @param flowId ID of the vesting flow.
	 * @param amount Amount of locked tokens to claim.
	 *
	 * @dev Claims unlocked tokens first, then processes locked amount with penalty.
	 */
	function _claimLockedToken(
		address user,
		uint256 flowId,
		uint256 amount
	) internal returns (uint256 unlockedClaimed, uint256 lockedClaimed, uint256 penalty) {
		// Claim any unlocked tokens first
		bool flowDeleted;
		(flowDeleted, unlockedClaimed) = _claimUnlockedToken(user, flowId);
		if (!flowDeleted) {
			Flow storage flow = _flows[flowId];
			amount = Math.min(amount, flow.amount);
			flowDeleted = flow.decreaseLockedAmount(amount);
			if (flowDeleted) _removeUserFlowId(user, flowId);
			totalVested -= amount;

			// Calculate and apply penalty
			penalty = (amount * lockedClaimPenaltyRate) / 1e18;
			lockedClaimed = amount - penalty;
			_ensureSufficientBalance(amount);
			SYMM.safeTransfer(user, lockedClaimed);
			SYMM.safeTransfer(lockedClaimPenaltyReceiver, penalty);
			emit LockedTokenClaimed(user, flowId, amount, penalty);
		}
	}

	/* ───────────────────── Cross-Chain Sync Functions ───────────────────── */

	/**
	 * @notice Update lock data for multiple NFTs for cross-chain synchronization.
	 * @param tokenIds  Array of token IDs to update.
	 * @param lockDatas Array of lock data to apply.
	 */
	function batchUpdateLockData(uint256[] calldata tokenIds, ISymmioBuildersNft.LockData[] calldata lockDatas) external onlyRole(SYNC_ROLE) {
		if (tokenIds.length != lockDatas.length) revert LengthMismatch();

		for (uint256 i = 0; i < tokenIds.length; i++) {
			nftContract.updateLockData(tokenIds[i], lockDatas[i].amount, lockDatas[i].unlockingAmount, lockDatas[i].name);
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
	 * @dev Only callable by accounts with SETTER_ROLE. Must be non-zero.
	 */
	function setCliffDuration(uint256 _cliffDuration) external onlyRole(SETTER_ROLE) {
		if (_cliffDuration == 0) revert InvalidDuration();
		cliffDuration = _cliffDuration;
		emit CliffDurationUpdated(_cliffDuration);
	}

	/**
	 * @notice Update the vesting duration for new vesting flows.
	 * @param _vestingDuration New vesting duration in seconds.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE. Must be non-zero.
	 */
	function setVestingDuration(uint256 _vestingDuration) external onlyRole(SETTER_ROLE) {
		if (_vestingDuration == 0) revert InvalidDuration();
		vestingDuration = _vestingDuration;
		emit VestingDurationUpdated(_vestingDuration);
	}

	/* ────────────────────────── View Functions ────────────────────────── */

	/**
	 * @notice Get all unlock request IDs for a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @return Array of unlock request IDs associated with the NFT.
	 */
	function getTokenUnlockIds(uint256 tokenId) external view returns (uint256[] memory) {
		return tokenUnlockIds[tokenId];
	}

	/**
	 * @notice Get unlock requests for a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @param start  Start index.
	 * @param end    End index.
	 * @param size   Maximum number of requests to return.
	 * @return Array of unlock requests.
	 */
	function getUnlockedRequests(uint256 tokenId, uint256 start, uint256 end, uint256 size) external view returns (UnlockRequest[] memory) {
		uint256[] memory unlockIds = tokenUnlockIds[tokenId];
		uint256 total = unlockIds.length;

		if (end > total) end = total;
		if (start > end) start = end;

		uint256 count = end - start;
		if (count > size) count = size;

		UnlockRequest[] memory requests = new UnlockRequest[](count);
		for (uint256 i = 0; i < count; i++) requests[i] = unlockRequests[unlockIds[start + i]];
		return requests;
	}

	/**
	 * @notice Get the cliff end time for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return Timestamp when the cliff period ends, or 0 if request is invalid.
	 */
	function getCliffEndTime(uint256 unlockId) external view returns (uint256) {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (unlockId >= _unlockIdCounter || request.amount == 0) revert UnlockNotFound();
		return request.unlockInitiatedTime + cliffDuration;
	}

	/**
	 * @notice Check if the cliff period has passed for an unlock request.
	 * @param unlockId ID of the unlock request.
	 * @return Whether the cliff period has passed.
	 */
	function isCliffPassed(uint256 unlockId) external view returns (bool) {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (unlockId >= _unlockIdCounter || request.amount == 0) revert UnlockNotFound();
		return block.timestamp >= request.unlockInitiatedTime + cliffDuration;
	}

	/**
	 * @notice Get the locked token amount for a specific vesting flow.
	 * @param flowId ID of the vesting flow.
	 * @return Amount of tokens still locked in the flow.
	 */
	function getLockedAmountForFlow(uint256 flowId) public view returns (uint256) {}

	/**
	 * @notice Get the claimable token amount for a specific vesting flow.
	 * @param flowId ID of the vesting flow.
	 * @return Amount of tokens currently claimable from the flow.
	 */
	function getClaimableAmountForFlow(uint256 flowId) public view returns (uint256) {}

	/**
	 * @notice Get the total locked tokens for a user across all vesting.
	 * @param user  Address of the user.
	 * @return totalLocked Total amount of locked tokens across all flows.
	 */
	function getTotalLockedAmount(address user) public view returns (uint256 totalLocked) {
		// uint256 count = userVestingFlowCount[token][user];
		// for (uint256 i = 0; i < count; i++) {
		// 	totalLocked += ;
		// }
	}

	/**
	 * @notice Get the total claimable tokens for a user across all vesting flows.
	 * @param user  Address of the user.
	 * @return totalClaimable Total amount of claimable tokens across all flows.
	 */
	function getTotalClaimableAmount(address user) public view returns (uint256 totalClaimable) {
		// uint256 count = userVestingFlowCount[token][user];
		// for (uint256 i = 0; i < count; i++) {
		// 	totalClaimable += ;
		// }
	}

	/* ───────────────────────── Internal Helpers ───────────────────────── */

	/**
	 * @dev Ensure the contract has sufficient SYMM balance, minting if necessary.
	 * @param amount Required amount of tokens.
	 */
	function _ensureSufficientBalance(uint256 amount) internal {
		uint256 currentBalance = SYMM.balanceOf(address(this));
		if (currentBalance < amount) {
			uint256 deficit = amount - currentBalance;
			// Attempt to mint tokens to cover the deficit
			SYMM.mint(address(this), deficit);
		}
	}

	function _removeUserFlowId(address user, uint256 flowId) internal {
		uint256[] storage flowIds = _userFlowIds[user];
		uint256 length = flowIds.length;

		for (uint256 i; i < length; ++i) {
			if (flowIds[i] == flowId) {
				flowIds[i] = flowIds[length - 1];
				flowIds.pop();
				return;
			}
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
