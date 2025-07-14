// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmUnlockManager
 * @notice Manages the unlock process for SYMM tokens locked in SymmioBuildersNFT contracts with
 *         cliff periods and vesting integration. Provides a complete workflow for token unlocking
 *         including request initiation, cliff enforcement, cancellation capabilities, and vesting setup.
 *
 * @dev    Core features include:
 *         • Unlock request management with unique ID tracking
 *         • Configurable cliff period enforcement before token release
 *         • Integration with external vesting contracts for gradual token release
 *         • Cancellation functionality for unlock requests during cliff period
 *         • Comprehensive tracking of unlock status and timing
 *         • Role-based access control for administrative functions
 *         • Emergency pause functionality for security incidents
 *         • Token rescue capabilities for administrative recovery
 *         • Detailed view functions for unlock request analysis
 *
 *         The contract coordinates between SymmioBuildersNFT for lock management and external
 *         vesting contracts for token distribution, ensuring secure and controlled token unlocking
 *         with configurable time-based restrictions and user flexibility.
 *
 * @dev    This contract is designed to be used with OpenZeppelin's TransparentUpgradeableProxy.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/**
 * @notice Interface for the SymmioBuildersNFT contract to query ownership and lock data.
 */
interface ISymmioBuildersNft {
	/**
	 * @notice Get the owner of a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @return Address of the NFT owner.
	 */
	function ownerOf(uint256 tokenId) external view returns (address);

	/**
	 * @notice Get the lock data for a specific NFT.
	 * @param tokenId ID of the NFT to query.
	 * @return amount          Amount of tokens locked.
	 * @return lockTimestamp   Timestamp when tokens were locked.
	 * @return brandName       Brand name associated with the NFT.
	 * @return unlockingAmount Amount currently being unlocked.
	 */
	function lockData(
		uint256 tokenId
	) external view returns (uint256 amount, uint256 lockTimestamp, string memory brandName, uint256 unlockingAmount);

	/**
	 * @notice Complete the unlock process for an NFT.
	 * @param tokenId ID of the NFT to unlock.
	 * @param amount  Amount of tokens to unlock.
	 */
	function completeUnlock(uint256 tokenId, uint256 amount) external;

	/**
	 * @notice Cancel an unlock process for an NFT.
	 * @param tokenId ID of the NFT to cancel unlock for.
	 * @param amount  Amount to cancel from the unlock process.
	 */
	function cancelUnlock(uint256 tokenId, uint256 amount) external;
}

/**
 * @notice Interface for the Vesting contract to set up vesting plans.
 */
interface IVesting {
	/**
	 * @notice Set up vesting plans for multiple users.
	 * @param token     Address of the token to vest.
	 * @param startTime Start time of the vesting period.
	 * @param endTime   End time of the vesting period.
	 * @param users     Array of user addresses.
	 * @param amounts   Array of token amounts for each user.
	 */
	function setupVestingPlans(address token, uint256 startTime, uint256 endTime, address[] memory users, uint256[] memory amounts) external;
}

contract SymmUnlockManager is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for updating configuration parameters like cliff and vesting durations.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for pausing contract operations.
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing contract operations.
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice The SymmioBuildersNFT contract.
	ISymmioBuildersNft public symmBuildersNft;

	/// @notice The Vesting contract for managing token vesting plans.
	IVesting public vestingContract;

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
	uint256[50] private __gap;

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Complete details of an unlock request with status tracking.
	 * @param amount               Amount of tokens to unlock.
	 * @param unlockInitiatedTime  Timestamp when unlock was initiated.
	 * @param owner                Owner of the NFT at unlock initiation.
	 * @param tokenId              ID of the NFT being unlocked.
	 * @param cliffPassed          Whether the cliff period has passed.
	 * @param vestingStarted       Whether vesting has started for this request.
	 */
	struct UnlockRequest {
		uint256 amount;
		uint256 unlockInitiatedTime;
		address owner;
		uint256 tokenId;
		bool cliffPassed;
		bool vestingStarted;
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
	 * @param unlockId ID of the unlock request.
	 * @param tokenId  ID of the NFT.
	 * @param owner    Owner of the NFT.
	 * @param amount   Amount of tokens entering vesting.
	 */
	event VestingStarted(uint256 indexed unlockId, uint256 indexed tokenId, address indexed owner, uint256 amount);

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
	 * @notice Emitted when the vesting contract address is updated.
	 * @param newVestingContract New vesting contract address.
	 */
	event VestingContractUpdated(address newVestingContract);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error NotNFTOwner(); // caller is not the owner of the NFT
	error UnlockNotFound(); // unlock request ID is invalid or not found
	error CliffNotPassed(); // cliff period has not yet passed
	error VestingAlreadyStarted(); // vesting has already started for this unlock request
	error InvalidDuration(); // invalid duration (zero) provided for cliff or vesting
	error ZeroAddress(); // zero address provided for critical parameters
	error ZeroAmount(); // zero amount provided for operations requiring non-zero value
	error UnauthorizedAccess(address caller, address requiredCaller); // unauthorized caller attempted restricted action

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the SymmUnlockManager with core contracts and configuration.
	 * @param _symmBuildersNft  Address of the SymmioBuildersNFT contract.
	 * @param _symm             Address of the SYMM token contract.
	 * @param _vestingContract  Address of the Vesting contract.
	 * @param _admin            Address to receive admin and all role assignments.
	 * @param _cliffDuration    Duration of the cliff period in seconds.
	 * @param _vestingDuration  Duration of the vesting period in seconds.
	 *
	 * @dev Sets up access control and validates all inputs. Reverts on zero addresses or invalid durations.
	 *      This replaces the constructor for upgradeable contracts.
	 */
	function initialize(
		address _symmBuildersNft,
		address _symm,
		address _vestingContract,
		address _admin,
		uint256 _cliffDuration,
		uint256 _vestingDuration
	) public initializer {
		if (_symmBuildersNft == address(0) || _symm == address(0) || _vestingContract == address(0) || _admin == address(0)) {
			revert ZeroAddress();
		}
		if (_cliffDuration == 0 || _vestingDuration == 0) {
			revert InvalidDuration();
		}

		// Initialize parent contracts
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		// Set contract addresses and parameters
		symmBuildersNft = ISymmioBuildersNft(_symmBuildersNft);
		SYMM = IERC20(_symm);
		vestingContract = IVesting(_vestingContract);
		cliffDuration = _cliffDuration;
		vestingDuration = _vestingDuration;

		// Initialize counter
		_unlockIdCounter = 0;

		// Grant roles to admin
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);
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
		if (msg.sender != address(symmBuildersNft)) {
			revert UnauthorizedAccess(msg.sender, address(symmBuildersNft));
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
			vestingStarted: false
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
		if (symmBuildersNft.ownerOf(request.tokenId) != msg.sender) {
			revert NotNFTOwner();
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
		symmBuildersNft.cancelUnlock(tokenId, amount);

		emit UnlockCancelled(unlockId, tokenId, owner, amount);
	}

	/**
	 * @notice Complete the cliff period and start vesting for an unlock request.
	 * @param unlockId ID of the unlock request to process.
	 *
	 * @dev Transfers tokens to vesting contract and sets up vesting plan.
	 *      Only callable by NFT owner after cliff period completion.
	 */
	function completeCliffAndStartVesting(uint256 unlockId) external nonReentrant whenNotPaused {
		UnlockRequest storage request = unlockRequests[unlockId];
		if (request.amount == 0) {
			revert UnlockNotFound();
		}
		if (symmBuildersNft.ownerOf(request.tokenId) != msg.sender) {
			revert NotNFTOwner();
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
		symmBuildersNft.completeUnlock(request.tokenId, request.amount);

		// Set up vesting plan for the owner
		address[] memory users = new address[](1);
		users[0] = request.owner;
		uint256[] memory amounts = new uint256[](1);
		amounts[0] = request.amount;

		// Approve vesting contract to transfer tokens
		SYMM.approve(address(vestingContract), request.amount);

		// Set up vesting plan starting from now
		vestingContract.setupVestingPlans(address(SYMM), block.timestamp, block.timestamp + vestingDuration, users, amounts);

		emit CliffCompleted(unlockId, request.tokenId, request.owner);
		emit VestingStarted(unlockId, request.tokenId, request.owner, request.amount);
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

	/**
	 * @notice Update the vesting contract address.
	 * @param _vestingContract New vesting contract address.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE. Cannot be zero address.
	 */
	function setVestingContract(address _vestingContract) external onlyRole(SETTER_ROLE) {
		if (_vestingContract == address(0)) {
			revert ZeroAddress();
		}
		vestingContract = IVesting(_vestingContract);
		emit VestingContractUpdated(_vestingContract);
	}

	/**
	 * @notice Rescue tokens accidentally sent to the contract.
	 * @param token  Address of the token to rescue.
	 * @param to     Recipient address for the rescued tokens.
	 * @param amount Amount of tokens to transfer.
	 *
	 * @dev Only callable by accounts with DEFAULT_ADMIN_ROLE for emergency recovery.
	 */
	function rescueTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
		IERC20(token).safeTransfer(to, amount);
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
	 * @notice Returns the current version of the contract.
	 * @return Version string of the contract.
	 * @dev This function can be used to verify which version of the contract is deployed.
	 */
	function version() external pure returns (string memory) {
		return "1.0.0";
	}
}
