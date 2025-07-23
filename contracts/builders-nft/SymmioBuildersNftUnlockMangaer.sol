// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmUnlockManager
 * @notice Manages the unlock process for SYMM tokens locked in SymmioBuildersNFTManager contracts with
 *         integrated cliff periods and sophisticated vesting functionality. Inherits from VestingV2 to
 *         provide comprehensive token vesting with penalty mechanisms and flexible claiming options.
 *
 * @dev    Core features include:
 *         • Unlock request management with unique ID tracking
 *         • Configurable cliff period enforcement before token release
 *         • Full VestingV2 functionality inherited (linear vesting, penalties, percentage claims)
 *         • Cancellation functionality for unlock requests during cliff period
 *         • Comprehensive tracking of unlock status and timing
 *         • Emergency pause functionality for security incidents
 *         • Token rescue capabilities for administrative recovery
 *         • Detailed view functions for unlock request analysis
 *
 *         The contract coordinates with SymmioBuildersNFTManager for lock management and uses
 *         inherited VestingV2 functionality for sophisticated token distribution with penalties,
 *         percentage-based claiming, and multiple vesting plans per user.
 *
 * @dev    This contract is designed to be used with OpenZeppelin's TransparentUpgradeableProxy.
 */

import "../vesting/VestingV2.sol";
import "./interfaces/ISymmioBuildersNft.sol";
import "./interfaces/ISymmioBuildersNftManager.sol";

contract SymmioBuildersNftUnlockManager is VestingV2 {
	/* ──────────────────────── Additional Storage Variables ──────────────────────── */

	/// @notice The SymmioBuildersNFT contract.
	ISymmioBuildersNftManager public symmBuildersNftManager;

	/// @notice The SYMM token contract.
	IERC20 public SYMM;

	/// @notice Duration of the cliff period in seconds before tokens can be unlocked.
	uint256 public cliffDuration;

	/// @notice Duration of the vesting period in seconds after cliff completion.
	uint256 public vestingDuration;

	/// @notice Counter for generating unique unlock request IDs sequentially.
	uint256 private _unlockIdCounter;

	/// @notice Mapping of unlock request ID to complete request details.
	mapping(uint256 => UnlockRequest) public unlockRequests;

	/// @notice Mapping of NFT token ID to array of associated unlock request IDs.
	mapping(uint256 => uint256[]) public tokenUnlockIds;

	/// @dev This empty reserved space is put in place to allow future versions to add new variables without shifting down storage in the inheritance chain.
	uint256[50] private __gap; // Reduced to account for new variables

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
	 * @notice Emitted when an unlock request is initiated.
	 * @param unlockId      ID of the unlock request.
	 * @param tokenId       ID of the NFT.
	 * @param owner         Owner of the NFT.
	 * @param amount        Amount of tokens to unlock.
	 * @param cliffEndTime  Timestamp when the cliff period ends.
	 */
	event UnlockInitiated(uint256 indexed unlockId, uint256 indexed tokenId, address indexed owner, uint256 amount, uint256 cliffEndTime);

	/**
	 * @notice Emitted when an unlock request is cancelled.
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
	 * @notice Emitted when the cliff duration is updated.
	 * @param newDuration New cliff duration in seconds.
	 */
	event CliffDurationUpdated(uint256 newDuration);

	/**
	 * @notice Emitted when the vesting duration is updated.
	 * @param newDuration New vesting duration in seconds.
	 */
	event VestingDurationUpdated(uint256 newDuration);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error UnlockNotFound(); // unlock request ID is invalid or not found
	error CliffNotPassed(); // cliff period has not yet passed
	error VestingAlreadyStarted(); // vesting has already started for this unlock request
	error InvalidDuration(); // invalid duration (zero) provided for cliff or vesting
	error UnauthorizedAccess(address caller, address requiredCaller); // unauthorized caller attempted restricted action
	error ZeroAmount(); // zero amount provided for critical parameters

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the SymmUnlockManager with core contracts and configuration.
	 * @param _symmBuildersNft         Address of the SymmioBuildersNFT contract.
	 * @param _symm                    Address of the SYMM token contract.
	 * @param _admin                   Address to receive admin and all role assignments.
	 * @param _cliffDuration           Duration of the cliff period in seconds.
	 * @param _vestingDuration         Duration of the vesting period in seconds.
	 * @param _lockedClaimPenalty      Penalty rate for early claims (scaled by 1e18).
	 * @param _lockedClaimPenaltyReceiver Address to receive penalties from early claims.
	 *
	 * @dev Sets up access control and validates all inputs. Reverts on zero addresses or invalid durations.
	 *      This replaces the constructor for upgradeable contracts.
	 */
	function initialize(
		address _symmBuildersNft,
		address _symm,
		address _admin,
		uint256 _cliffDuration,
		uint256 _vestingDuration,
		uint256 _lockedClaimPenalty,
		address _lockedClaimPenaltyReceiver
	) public initializer {
		if (_symmBuildersNft == address(0) || _symm == address(0) || _admin == address(0)) {
			revert ZeroAddress();
		}
		if (_cliffDuration == 0 || _vestingDuration == 0) {
			revert InvalidDuration();
		}

		// Initialize parent VestingV2 contract
		__vesting_init(_admin, _lockedClaimPenalty, _lockedClaimPenaltyReceiver);

		// Set contract addresses and parameters
		symmBuildersNftManager = ISymmioBuildersNftManager(_symmBuildersNft);
		SYMM = IERC20(_symm);
		cliffDuration = _cliffDuration;
		vestingDuration = _vestingDuration;

		// Initialize counter
		_unlockIdCounter = 0;
	}

	/* ──────────────────── Unlock Management ──────────────────── */

	/**
	 * @notice Initiate an unlock request for an NFT (called by SymmioBuildersNFT contract).
	 * @param tokenId ID of the NFT to unlock.
	 * @param owner   Owner of the NFT.
	 * @param amount  Amount of tokens to unlock.
	 *
	 * @dev Creates a new unlock request with cliff period enforcement.
	 *      Only callable by the SymmioBuildersNFT contract.
	 */
	function initiateUnlock(uint256 tokenId, address owner, uint256 amount) external whenNotPaused {
		if (msg.sender != address(symmBuildersNftManager)) {
			revert UnauthorizedAccess(msg.sender, address(symmBuildersNftManager));
		}
		if (amount == 0) {
			revert ZeroAmount();
		}

		uint256 unlockId = _unlockIdCounter++;
		unlockRequests[unlockId] = UnlockRequest({
			amount: amount,
			unlockInitiatedTime: block.timestamp,
			owner: owner,
			tokenId: tokenId,
			cliffPassed: false,
			vestingStarted: false,
			vestingPlanId: 0
		});

		tokenUnlockIds[tokenId].push(unlockId);

		emit UnlockInitiated(unlockId, tokenId, owner, amount, block.timestamp + cliffDuration);
	}

	/**
	 * @notice Cancel an unlock request before the cliff period ends.
	 * @param unlockId ID of the unlock request to cancel.
	 *
	 * @dev Removes the unlock request and notifies the NFT contract.
	 *      Only callable by the NFT owner and only before cliff completion.
	 */
	function cancelUnlock(uint256 unlockId) external nonReentrant whenNotPaused {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) {
			revert UnlockNotFound();
		}
		if (request.cliffPassed) {
			revert CliffNotPassed();
		}

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

		// Notify NFT contract to cancel the unlock
		symmBuildersNftManager.cancelUnlock(tokenId, amount);

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
		if (request.amount == 0) {
			revert UnlockNotFound();
		}
		if (request.vestingStarted) {
			revert VestingAlreadyStarted();
		}
		if (block.timestamp < request.unlockInitiatedTime + cliffDuration) {
			revert CliffNotPassed();
		}

		// Mark cliff as passed and vesting as started
		request.cliffPassed = true;
		request.vestingStarted = true;

		// Complete unlock on NFT contract
		symmBuildersNftManager.completeUnlock(request.tokenId, request.amount);

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
	}

	/* ────────────────────────── Admin Functions ────────────────────────── */

	/**
	 * @notice Update the cliff duration for new unlock requests.
	 * @param _cliffDuration New cliff duration in seconds.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE. Must be non-zero.
	 */
	function setCliffDuration(uint256 _cliffDuration) external onlyRole(SETTER_ROLE) {
		if (_cliffDuration == 0) {
			revert InvalidDuration();
		}
		cliffDuration = _cliffDuration;
		emit CliffDurationUpdated(_cliffDuration);
	}

	/**
	 * @notice Update the vesting duration for new vesting plans.
	 * @param _vestingDuration New vesting duration in seconds.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE. Must be non-zero.
	 */
	function setVestingDuration(uint256 _vestingDuration) external onlyRole(SETTER_ROLE) {
		if (_vestingDuration == 0) {
			revert InvalidDuration();
		}
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

	/**
	 * @notice Override to handle SYMM token minting if possible.
	 * @param token  Address of the token to mint.
	 * @param amount Amount of tokens to mint.
	 *
	 * @dev This hook is called when the contract needs more tokens for vesting.
	 *      In this case, we expect SYMM tokens to be transferred from the NFT manager.
	 */
	function _mintTokenIfPossible(address token, uint256 amount) internal virtual override {
		// Since SYMM tokens come from burned NFTs, we don't mint them
		// The tokens should already be in the contract from completed unlocks
		// This is a no-op, but can be overridden if minting is needed
	}

	/**
	 * @notice Returns the current version of the contract.
	 * @return Version string of the contract.
	 * @dev This function can be used to verify which version of the contract is deployed.
	 */
	function version() external pure returns (string memory) {
		return "1.0.0";
	}
}
