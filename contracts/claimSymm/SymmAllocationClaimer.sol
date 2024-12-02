// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IMintableERC20} from "./interfaces/IERC20Minter.sol";

/**
 * @title SymmAllocationClaimer
 * @dev Contract for managing user allocations with 18 decimal precision
 */
contract SymmAllocationClaimer is AccessControlEnumerable, Pausable {
    // using SafeMath for uint256;

    bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

    uint256 public constant MAX_ISSUABLE_TOKEN = 400_000_000 * 1e18;
    address public immutable token;
    uint256 public immutable mintFactor; // decimal 18
    address public symmioFoundation;
    // Mapping from user address to their allocation (with 18 decimals precision)
    mapping(address => uint256) public userAllocations;
    mapping(address => uint256) public claimedAmount;
    uint256 public totalAllocation;
    uint256 public totalClaimedAmount;
    uint256 public totalAvailableAmountForAdmin;
    uint256 public totalMintAmount;

    // Events
    event SetBatchAllocations(address[] users, uint256[] powers);
    event Claim(address user, uint256 amount);
    event ClaimForAdmin(address sender, address receiver, uint256 amount);
    event SetSymmioFoundationAddress(address newAddress);

    // Errors
    error UserHasNoClaim(address user, bool state);
    error AdminClaimAmountLargerThanAvailableAmount(
        uint256 availableAmount,
        uint256 claimRequestAmount
    );
    error ZeroAddress();
    error InvalidFactor();
    error ArrayLengthMismatch();
    error EmptyArrays();

    constructor(
        address admin,
        address setter,
        address _token,
        address _symmioFoundation,
        uint256 _mintFactor
    ) {
        if (
            _token == address(0) ||
            admin == address(0) ||
            setter == address(0) ||
            _symmioFoundation == address(0)
        ) {
            revert ZeroAddress();
        }
        if (_mintFactor > 1e18 || _mintFactor == 0) {
            revert InvalidFactor();
        }

        token = _token;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTER_ROLE, setter);
        symmioFoundation = _symmioFoundation;
        mintFactor = _mintFactor;

        emit SetSymmioFoundationAddress(symmioFoundation);
    }

    function setSymmioFoundationAddress(
        address newAddress
    ) external onlyRole(SETTER_ROLE) {
        if (newAddress == address(0)) {
            revert ZeroAddress();
        }
        symmioFoundation = newAddress;
        emit SetSymmioFoundationAddress(symmioFoundation);
    }

    /**
     * @dev Sets allocations for multiple users in a single transaction
     * Updates totalAllocation by subtracting old values and adding new ones
     * @param users Array of user addresses
     * @param allocations Array of allocation values with 18 decimals
     */
    function setBatchAllocations(
        address[] calldata users,
        uint256[] calldata allocations
    ) external onlyRole(SETTER_ROLE) {
        if (users.length != allocations.length) revert ArrayLengthMismatch();
        if (users.length == 0) revert EmptyArrays();
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] == address(0)) revert ZeroAddress();
            // Subtract old power from total
            totalAllocation = totalAllocation - userAllocations[users[i]];
            // Set new power
            userAllocations[users[i]] = allocations[i];
            // Add new power to total
            totalAllocation = totalAllocation + allocations[i];
        }
        emit SetBatchAllocations(users, allocations);
    }

    /**
     * @dev Allows a user to claim their allocation as minted ERC20 tokens
     */
    function claim() public whenNotPaused {
        require(
            userAllocations[msg.sender] > 0,
            "User allocation must be larger than 0"
        );
        require(
            userAllocations[msg.sender] + totalMintAmount <= MAX_ISSUABLE_TOKEN,
            "Max mintable token is reached"
        );
        uint256 amountToClaim = (userAllocations[msg.sender] * mintFactor) /
            1e18;
        totalAvailableAmountForAdmin += (userAllocations[msg.sender] -
            amountToClaim);
        totalMintAmount += userAllocations[msg.sender];
        userAllocations[msg.sender] = 0;
        totalClaimedAmount += amountToClaim;
        claimedAmount[msg.sender] += amountToClaim;
        IMintableERC20(token).mint(msg.sender, amountToClaim);
        emit Claim(msg.sender, amountToClaim);
    }

    function claimForAdmin(uint256 amount) external onlyRole(MINTER_ROLE) {
        if (amount > totalAvailableAmountForAdmin) {
            revert AdminClaimAmountLargerThanAvailableAmount(
                totalAvailableAmountForAdmin,
                amount
            );
        }
        totalAvailableAmountForAdmin -= amount;
        IMintableERC20(token).mint(symmioFoundation, amount);
        emit ClaimForAdmin(msg.sender, symmioFoundation, amount);
    }

    /// @notice Pauses the contract
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses the contract
    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }
}
