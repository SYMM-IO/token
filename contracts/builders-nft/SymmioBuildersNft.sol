// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title  SymmioBuildersNft
 * @notice A simple ERC721 NFT contract for Symmio Builders with brand name customization.
 *         All complex logic is handled by the SymmioBuildersNftManager contract.
 *
 * @dev    This contract focuses solely on NFT minting, transfers, and brand name management.
 *         The manager contract handles all lock data, unlock processes, and fee management.
 */

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./interfaces/ISymmioBuildersNft.sol";

contract SymmioBuildersNft is
	Initializable,
	ERC721EnumerableUpgradeable,
	AccessControlEnumerableUpgradeable,
	PausableUpgradeable,
	ISymmioBuildersNft
{
	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for minting NFTs through the manager contract.
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	/// @notice Role for burning NFTs through the manager contract.
	bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

	/// @notice Role for pausing the contract operations.
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing the contract operations.
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice Counter for generating unique token IDs sequentially.
	uint256 private _tokenIdCounter;

	/// @notice Whether transfers are paused.
	bool public transfersPaused;

	/// @notice Mapping of token ID to its lock data.
	mapping(uint256 => ISymmioBuildersNft.LockData) public lockData;

	/// @dev This empty reserved space is put in place to allow future versions to add new variables without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/**
	 * @notice Emitted when an NFT is minted.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param amount    Amount of SYMM tokens locked.
	 * @param name      Name associated with the NFT.
	 */
	event NFTMinted(address indexed to, uint256 indexed tokenId, uint256 amount, string name);

	/**
	 * @notice Emitted when an NFT's lock data is updated.
	 * @param tokenId            ID of the NFT.
	 * @param amount             Amount of SYMM tokens locked.
	 * @param unlockingAmount    Amount of SYMM tokens being unlocked.
	 * @param name               Name associated with the NFT.
	 */
	event LockDataUpdated(uint256 indexed tokenId, uint256 amount, uint256 unlockingAmount, string name);

	/**
	 * @notice Emitted when the transfer pause state is updated.
	 * @param paused New pause state (true for paused, false for unpaused).
	 */
	event TransfersPausedUpdated(bool paused);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error NotTokenOwner(); // caller is not the owner of the NFT
	error ZeroAddress(); // zero address provided for critical parameters
	error TransfersPaused(); // transfers are paused
	error TokenHasActiveUnlock(); // token has an active unlock
	error InvalidLockData(); // invalid lock data for a token

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the upgradeable SymmioBuildersNft contract.
	 * @param _admin   Address to receive admin and all role assignments.
	 *
	 * @dev Sets up the ERC721 contract and assigns roles.
	 */
	function initialize(address _admin) public initializer {
		if (_admin == address(0)) revert ZeroAddress();

		// Initialize parent contracts
		__ERC721_init("Symmio Builders NFT", "BUILDERS");
		__ERC721Enumerable_init();
		__AccessControlEnumerable_init();
		__Pausable_init();

		// Grant roles to admin
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);
	}

	/* ────────────────────────── Core Functions ────────────────────────── */

	/**
	 * @notice Mint a new NFT with a brand name.
	 * @param to        Address to mint the NFT to.
	 * @param amount    Amount of SYMM tokens to lock.
	 * @param name      Name for the NFT.
	 * @return tokenId  ID of the newly minted NFT.
	 *
	 * @dev Only callable by addresses with MINTER_ROLE (typically the manager contract).
	 */
	function mint(address to, uint256 amount, string memory name) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 tokenId) {
		tokenId = _tokenIdCounter++;
		_safeMint(to, tokenId);
		lockData[tokenId] = ISymmioBuildersNft.LockData({ amount: amount, lockTimestamp: block.timestamp, unlockingAmount: 0, name: name });

		emit NFTMinted(to, tokenId, amount, name);
	}

	/**
	 * @notice Burn an NFT.
	 * @param tokenId ID of the NFT to burn.
	 *
	 * @dev Only callable by addresses with BURNER_ROLE (typically the manager contract).
	 */
	function burn(uint256 tokenId) external onlyRole(BURNER_ROLE) whenNotPaused {
		_burn(tokenId);
		delete lockData[tokenId];
	}

	/**
	 * @notice Update the lock data of an NFT.
	 * @param tokenId       ID of the NFT to update.
	 * @param amount        Amount of SYMM tokens locked.
	 * @param name          Name associated with the NFT.
	 *
	 * @dev Only callable by the NFT owner.
	 */
	function updateLockData(uint256 tokenId, uint256 amount, uint256 unlockingAmount, string memory name) external onlyRole(MINTER_ROLE) {
		_validateLockData(tokenId, amount, unlockingAmount);
		lockData[tokenId] = ISymmioBuildersNft.LockData({
			amount: amount,
			lockTimestamp: lockData[tokenId].lockTimestamp,
			unlockingAmount: unlockingAmount,
			name: name
		});

		emit LockDataUpdated(tokenId, amount, unlockingAmount, name);
	}

	/* ────────────────────────── View Functions ────────────────────────── */

	/**
	 * @notice Get the lock data of an NFT.
	 * @param tokenId ID of the NFT.
	 * @return Lock data of the NFT.
	 */
	function getLockData(uint256 tokenId) external view returns (ISymmioBuildersNft.LockData memory) {
		_requireOwned(tokenId);
		return lockData[tokenId];
	}

	/**
	 * @notice Get the effective locked amount for an NFT (excluding unlocking amounts).
	 * @param tokenId ID of the NFT.
	 * @return The effective locked amount available for fee reductions.
	 */
	function getEffectiveLockedAmount(uint256 tokenId) external view returns (uint256) {
		_requireOwned(tokenId);
		LockData storage data = lockData[tokenId];
		return data.amount - data.unlockingAmount;
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

	/* ───────────────────────── Pause Controls ───────────────────────── */

	/**
	 * @notice Pause the contract, disabling minting and transfers.
	 * @dev Only callable by accounts with PAUSER_ROLE.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpause the contract, enabling minting and transfers.
	 * @dev Only callable by accounts with UNPAUSER_ROLE.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/**
	 * @notice Pause the contract, disabling transfers.
	 * @dev Only callable by accounts with PAUSER_ROLE.
	 */
	function pauseTransfers() external onlyRole(PAUSER_ROLE) {
		transfersPaused = true;
		emit TransfersPausedUpdated(true);
	}

	/**
	 * @notice Unpause the contract, enabling transfers.
	 * @dev Only callable by accounts with UNPAUSER_ROLE.
	 */
	function unpauseTransfers() external onlyRole(UNPAUSER_ROLE) {
		transfersPaused = false;
		emit TransfersPausedUpdated(false);
	}

	/* ───────────────────────── Internal Overrides ───────────────────────── */

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

	function _validateLockData(uint256 tokenId, uint256 amount, uint256 unlockingAmount) internal view {
		_requireOwned(tokenId);
		if (unlockingAmount > amount) revert InvalidLockData();
	}

	/* ──────────────────── Interface Support ──────────────────── */

	/**
	 * @notice Check if the contract supports a given interface.
	 * @param interfaceId Interface ID to check.
	 * @return Whether the interface is supported.
	 */
	function supportsInterface(
		bytes4 interfaceId
	) public view override(ERC721EnumerableUpgradeable, AccessControlEnumerableUpgradeable, IERC165) returns (bool) {
		return super.supportsInterface(interfaceId);
	}

	/**
	 * @notice Get the current contract version.
	 * @return The version string of the current contract.
	 */
	function version() external pure returns (string memory) {
		return "1.0.0";
	}
}
