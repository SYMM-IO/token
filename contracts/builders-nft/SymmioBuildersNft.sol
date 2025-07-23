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

import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract SymmioBuildersNft is Initializable, ERC721EnumerableUpgradeable, AccessControlEnumerableUpgradeable, PausableUpgradeable {
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

	/// @notice Mapping of token ID to its brand name.
	mapping(uint256 => string) public brandNames;

	/// @dev This empty reserved space is put in place to allow future versions to add new variables without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/**
	 * @notice Emitted when an NFT is minted.
	 * @param to        Address receiving the NFT.
	 * @param tokenId   ID of the minted NFT.
	 * @param brandName Brand name associated with the NFT.
	 */
	event NFTMinted(address indexed to, uint256 indexed tokenId, string brandName);

	/**
	 * @notice Emitted when an NFT's brand name is updated.
	 * @param tokenId      ID of the NFT.
	 * @param newBrandName New brand name assigned.
	 */
	event BrandNameUpdated(uint256 indexed tokenId, string newBrandName);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error NotTokenOwner(); // caller is not the owner of the NFT
	error ZeroAddress(); // zero address provided for critical parameters

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initialize the upgradeable SymmioBuildersNft contract.
	 * @param _admin   Address to receive admin and all role assignments.
	 * @param _manager Address of the manager contract to receive minter/burner roles.
	 *
	 * @dev Sets up the ERC721 contract and assigns roles.
	 */
	function initialize(address _admin, address _manager) public initializer {
		if (_admin == address(0) || _manager == address(0)) revert ZeroAddress();

		// Initialize parent contracts
		__ERC721_init("Symmio Builders NFT", "BUILDERS");
		__ERC721Enumerable_init();
		__AccessControlEnumerable_init();
		__Pausable_init();

		// Grant roles to admin
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);

		// Grant minter and burner roles to manager
		_grantRole(MINTER_ROLE, _manager);
		_grantRole(BURNER_ROLE, _manager);
	}

	/* ────────────────────────── Core Functions ────────────────────────── */

	/**
	 * @notice Mint a new NFT with a brand name.
	 * @param to        Address to mint the NFT to.
	 * @param brandName Brand name for the NFT.
	 * @return tokenId  ID of the newly minted NFT.
	 *
	 * @dev Only callable by addresses with MINTER_ROLE (typically the manager contract).
	 */
	function mint(address to, string memory brandName) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 tokenId) {
		tokenId = _tokenIdCounter++;
		_safeMint(to, tokenId);
		brandNames[tokenId] = brandName;

		emit NFTMinted(to, tokenId, brandName);
	}

	/**
	 * @notice Mint a specific NFT ID with a brand name (used for cross-chain sync).
	 * @param to        Address to mint the NFT to.
	 * @param tokenId   Specific token ID to mint.
	 * @param brandName Brand name for the NFT.
	 *
	 * @dev Only callable by addresses with MINTER_ROLE. Updates counter to avoid conflicts.
	 */
	function mintWithId(address to, uint256 tokenId, string memory brandName) external onlyRole(MINTER_ROLE) whenNotPaused {
		// Update token ID counter to avoid conflicts
		if (tokenId >= _tokenIdCounter) {
			_tokenIdCounter = tokenId + 1;
		}

		_safeMint(to, tokenId);
		brandNames[tokenId] = brandName;

		emit NFTMinted(to, tokenId, brandName);
	}

	/**
	 * @notice Burn an NFT.
	 * @param tokenId ID of the NFT to burn.
	 *
	 * @dev Only callable by addresses with BURNER_ROLE (typically the manager contract).
	 */
	function burn(uint256 tokenId) external onlyRole(BURNER_ROLE) {
		_burn(tokenId);
		delete brandNames[tokenId];
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

		brandNames[tokenId] = newBrandName;

		emit BrandNameUpdated(tokenId, newBrandName);
	}

	/* ────────────────────────── View Functions ────────────────────────── */

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

	/* ───────────────────────── Internal Overrides ───────────────────────── */

	/**
	 * @dev Override _update to add pause check for transfers.
	 */
	function _update(address to, uint256 tokenId, address auth) internal virtual override whenNotPaused returns (address) {
		return super._update(to, tokenId, auth);
	}

	/* ──────────────────── Interface Support ──────────────────── */

	/**
	 * @notice Check if the contract supports a given interface.
	 * @param interfaceId Interface ID to check.
	 * @return Whether the interface is supported.
	 */
	function supportsInterface(
		bytes4 interfaceId
	) public view override(ERC721EnumerableUpgradeable, AccessControlEnumerableUpgradeable) returns (bool) {
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
