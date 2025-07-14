"""
Vesting Plan Update Script

This script updates vesting plans by adding specified amounts to existing locked amounts.
For users without existing plans, it creates new vesting plans.

Usage:
    python update_vesting_plans.py              # Run in live mode (sends transactions)
    python update_vesting_plans.py --dry-run    # Run in dry mode (no transactions)

Dry run mode will:
- Calculate all changes
- Show what would be updated
- Save results to files for review
- NOT send any transactions
"""

import json
import os
import csv
import sys
from typing import List, Tuple
from multicallable import Multicallable
from web3 import Web3
from eth_account import Account
import time

# Configuration
RPC_URL = "https://base.drpc.org"  # You can change this to your preferred RPC
VESTING_CONTRACT_ADDRESS = ""  # Replace with your deployed contract address
TOKEN_ADDRESS = ""  # Replace with the token address for vesting
PRIVATE_KEY = ""  # Replace with your private key (keep this secure!)

# Vesting schedule configuration for new plans
VESTING_START_TIME = int(time.time())  # Default: current time
VESTING_END_TIME = int(time.time()) + (365 * 24 * 60 * 60)  # Default: 1 year from now

# CSV Input Format:
# The CSV file should have two columns: 'user' and 'amount'
# Example:
# user,amount
# 0x1234567890123456789012345678901234567890,1000000000000000000
# 0x2345678901234567890123456789012345678901,2000000000000000000

# Dry Run Mode:
# Use --dry-run flag to simulate the update without sending transactions
# This will create two output files:
# 1. dry_run_batches_<timestamp>.json - Detailed batch information
# 2. dry_run_summary_<timestamp>.csv - Summary of all updates

# Initialize Web3
w3 = Web3(Web3.HTTPProvider(RPC_URL))

# Only initialize account if not in dry run mode
account = None
if PRIVATE_KEY != "YOUR_PRIVATE_KEY":
    account = Account.from_key(PRIVATE_KEY)

# Vesting contract ABI (minimal ABI with just the functions we need)
VESTING_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "user", "type": "address"},
            {"internalType": "address", "name": "token", "type": "address"},
        ],
        "name": "getLockedAmountsForToken",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "", "type": "address"},
            {"internalType": "address", "name": "", "type": "address"},
        ],
        "name": "vestingPlans",
        "outputs": [
            {"internalType": "uint256", "name": "totalAmount", "type": "uint256"},
            {"internalType": "uint256", "name": "claimedAmount", "type": "uint256"},
            {"internalType": "uint256", "name": "startTime", "type": "uint256"},
            {"internalType": "uint256", "name": "endTime", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "address[]", "name": "users", "type": "address[]"},
            {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"},
        ],
        "name": "resetVestingPlans",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "uint256", "name": "startTime", "type": "uint256"},
            {"internalType": "uint256", "name": "endTime", "type": "uint256"},
            {"internalType": "address[]", "name": "users", "type": "address[]"},
            {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"},
        ],
        "name": "setupVestingPlans",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]


def load_user_updates(filename: str) -> List[Tuple[str, int]]:
    """
    Load user addresses and amounts to add from a CSV file.
    Expected format: CSV with columns 'user' and 'amount'
    """
    import csv

    user_updates = []

    with open(filename, "r") as f:
        reader = csv.DictReader(f)

        # Check if required columns exist
        if "user" not in reader.fieldnames or "amount" not in reader.fieldnames:
            raise ValueError("CSV must have 'user' and 'amount' columns")

        for row in reader:
            user = w3.to_checksum_address(row["user"].strip())
            amount = int(row["amount"].strip())
            user_updates.append((user, amount))

    print(f"Loaded {len(user_updates)} user updates from CSV")
    return user_updates


def get_vesting_plan_info(users: List[str], token: str) -> List[Tuple]:
    """
    Get vesting plan information for all users
    Returns list of tuples: (totalAmount, claimedAmount, startTime, endTime)
    """
    print(f"Fetching vesting plan information for {len(users)} users...")

    # Create multicallable contract instance
    contract = Multicallable(
        w3.to_checksum_address(VESTING_CONTRACT_ADDRESS), VESTING_ABI, w3
    )

    # Prepare calls for vestingPlans
    calls = []
    for user in users:
        calls.append((token, user))

    # Execute multicall
    vesting_info = contract.vestingPlans(calls).call(
        n=len(users) // 200 + 1,  # Split into chunks of 200
        progress_bar=True,
    )

    return vesting_info


def categorize_users(
    user_updates: List[Tuple[str, int]], vesting_info: List[Tuple]
) -> Tuple[List[Tuple[str, int]], List[Tuple[str, int]]]:
    """
    Categorize users into those with existing plans and those without
    Returns: (existing_users, new_users)
    """
    existing_users = []
    new_users = []

    for i, (user, amount) in enumerate(user_updates):
        total_amount = vesting_info[i][0]  # totalAmount from vestingPlans

        if total_amount > 0:
            # User has an existing vesting plan
            existing_users.append((user, amount))
        else:
            # User doesn't have a vesting plan
            new_users.append((user, amount))

    return existing_users, new_users


def prepare_update_data(
    user_updates: List[Tuple[str, int]],
    vesting_info: List[Tuple],
    dry_run: bool = False,
) -> Tuple[List[Tuple[str, int]], List[Tuple[str, int]]]:
    """
    Prepare update data for both existing and new vesting plans
    For existing plans: add amounts to current locked amounts
    For new plans: use the input amounts directly
    Returns: (existing_updates, new_setups)
    """
    existing_updates = []
    new_setups = []

    if dry_run:
        print("\nCalculating updates:")
        print("-" * 100)
        print(
            f"{'User Address':<42} {'Status':<15} {'Current':<20} {'To Add':<20} {'New Total':<20}"
        )
        print("-" * 100)

    total_current = 0
    total_to_add = 0
    total_new = 0

    for i, (user, amount_to_add) in enumerate(user_updates):
        total_amount = vesting_info[i][0]
        claimed_amount = vesting_info[i][1]

        if total_amount > 0:
            # Existing vesting plan - calculate current locked and add new amount
            current_locked = total_amount - claimed_amount
            new_amount = current_locked + amount_to_add
            existing_updates.append((user, new_amount))
            status = "EXISTING"

            if dry_run:
                print(
                    f"{user} {status:<15} {current_locked:<20} {amount_to_add:<20} {new_amount:<20}"
                )
                total_current += current_locked
                total_to_add += amount_to_add
                total_new += new_amount
        else:
            # No vesting plan - use input amount directly
            new_setups.append((user, amount_to_add))
            status = "NEW"

            if dry_run:
                print(
                    f"{user} {status:<15} {'0':<20} {amount_to_add:<20} {amount_to_add:<20}"
                )
                total_to_add += amount_to_add
                total_new += amount_to_add

    if dry_run:
        print("-" * 100)
        print(
            f"{'TOTALS:':<42} {'':<15} {total_current:<20} {total_to_add:<20} {total_new:<20}"
        )
        print("-" * 100)
        print(f"Existing vesting plans to update: {len(existing_updates)}")
        print(f"New vesting plans to create: {len(new_setups)}")
        print(f"Total users: {len(user_updates)}")

    return existing_updates, new_setups


def send_reset_batch_transaction(
    token: str, users: List[str], amounts: List[int], batch_num: int
) -> str:
    """
    Send a transaction to reset vesting plans for a batch of users
    """
    if not account:
        raise ValueError(
            "Account not initialized. Please set PRIVATE_KEY in the configuration."
        )

    contract = w3.eth.contract(
        address=w3.to_checksum_address(VESTING_CONTRACT_ADDRESS), abi=VESTING_ABI
    )

    # Build transaction
    nonce = w3.eth.get_transaction_count(account.address)

    tx = contract.functions.resetVestingPlans(token, users, amounts).build_transaction(
        {
            "from": account.address,
            "nonce": nonce,
            "gas": 5000000,  # Adjust based on your needs
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        }
    )

    # Sign and send transaction
    signed_tx = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)

    print(f"Reset batch {batch_num} transaction sent: {tx_hash.hex()}")

    # Wait for confirmation
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

    if receipt["status"] == 1:
        print(f"Reset batch {batch_num} transaction successful!")
    else:
        print(f"Reset batch {batch_num} transaction failed!")
        raise Exception(f"Transaction failed for reset batch {batch_num}")

    return tx_hash.hex()


def send_setup_batch_transaction(
    token: str, users: List[str], amounts: List[int], batch_num: int
) -> str:
    """
    Send a transaction to setup new vesting plans for a batch of users
    """
    if not account:
        raise ValueError(
            "Account not initialized. Please set PRIVATE_KEY in the configuration."
        )

    contract = w3.eth.contract(
        address=w3.to_checksum_address(VESTING_CONTRACT_ADDRESS), abi=VESTING_ABI
    )

    # Build transaction
    nonce = w3.eth.get_transaction_count(account.address)

    tx = contract.functions.setupVestingPlans(
        token, VESTING_START_TIME, VESTING_END_TIME, users, amounts
    ).build_transaction(
        {
            "from": account.address,
            "nonce": nonce,
            "gas": 5000000,  # Adjust based on your needs
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        }
    )

    # Sign and send transaction
    signed_tx = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)

    print(f"Setup batch {batch_num} transaction sent: {tx_hash.hex()}")

    # Wait for confirmation
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

    if receipt["status"] == 1:
        print(f"Setup batch {batch_num} transaction successful!")
    else:
        print(f"Setup batch {batch_num} transaction failed!")
        raise Exception(f"Transaction failed for setup batch {batch_num}")

    return tx_hash.hex()


def update_vesting_plans(input_file: str, batch_size: int = 300, dry_run: bool = False):
    """
    Main function to update vesting plans from a CSV file

    Args:
        input_file: Path to CSV file with user addresses and amounts
        batch_size: Number of users to process in each transaction
        dry_run: If True, only calculate and display changes without sending transactions
    """
    # Validate configuration
    if VESTING_CONTRACT_ADDRESS == "YOUR_VESTING_CONTRACT_ADDRESS":
        raise ValueError("Please set VESTING_CONTRACT_ADDRESS in the configuration")
    if TOKEN_ADDRESS == "YOUR_TOKEN_ADDRESS":
        raise ValueError("Please set TOKEN_ADDRESS in the configuration")
    if not dry_run and PRIVATE_KEY == "YOUR_PRIVATE_KEY":
        raise ValueError("Please set PRIVATE_KEY in the configuration for live mode")

    # Load user updates
    user_updates = load_user_updates(input_file)
    print(f"Loaded {len(user_updates)} user updates")

    # Extract users list
    users = [user for user, _ in user_updates]

    # Get vesting plan information for all users
    vesting_info = get_vesting_plan_info(users, TOKEN_ADDRESS)

    # Prepare updated data, separating existing and new users
    existing_updates, new_setups = prepare_update_data(
        user_updates, vesting_info, dry_run
    )

    # Process batches for both existing and new users
    all_transaction_hashes = []
    all_batch_data = []

    # Process existing user updates (resetVestingPlans)
    if existing_updates:
        print(f"\n{'=' * 50}")
        print(f"Processing {len(existing_updates)} existing vesting plan updates...")
        print(f"{'=' * 50}")

        total_reset_batches = (len(existing_updates) + batch_size - 1) // batch_size

        for batch_num in range(total_reset_batches):
            start_idx = batch_num * batch_size
            end_idx = min((batch_num + 1) * batch_size, len(existing_updates))

            batch_data = existing_updates[start_idx:end_idx]
            batch_users = [user for user, _ in batch_data]
            batch_amounts = [amount for _, amount in batch_data]

            print(
                f"\nProcessing RESET batch {batch_num + 1}/{total_reset_batches} ({len(batch_data)} users)..."
            )

            if dry_run:
                batch_info = {
                    "operation": "reset",
                    "batch_number": batch_num + 1,
                    "users": batch_users,
                    "amounts": batch_amounts,
                    "user_updates": batch_data,
                }
                all_batch_data.append(batch_info)
            else:
                try:
                    tx_hash = send_reset_batch_transaction(
                        TOKEN_ADDRESS, batch_users, batch_amounts, batch_num + 1
                    )
                    all_transaction_hashes.append(("reset", tx_hash))
                    time.sleep(2)
                except Exception as e:
                    print(f"Error processing reset batch {batch_num + 1}: {e}")
                    save_progress(all_transaction_hashes, batch_num)
                    raise

    # Process new user setups (setupVestingPlans)
    if new_setups:
        print(f"\n{'=' * 50}")
        print(f"Processing {len(new_setups)} new vesting plan setups...")
        print(
            f"Vesting period: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(VESTING_START_TIME))} to {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(VESTING_END_TIME))}"
        )
        print(f"{'=' * 50}")

        total_setup_batches = (len(new_setups) + batch_size - 1) // batch_size

        for batch_num in range(total_setup_batches):
            start_idx = batch_num * batch_size
            end_idx = min((batch_num + 1) * batch_size, len(new_setups))

            batch_data = new_setups[start_idx:end_idx]
            batch_users = [user for user, _ in batch_data]
            batch_amounts = [amount for _, amount in batch_data]

            print(
                f"\nProcessing SETUP batch {batch_num + 1}/{total_setup_batches} ({len(batch_data)} users)..."
            )

            if dry_run:
                batch_info = {
                    "operation": "setup",
                    "batch_number": batch_num + 1,
                    "users": batch_users,
                    "amounts": batch_amounts,
                    "user_updates": batch_data,
                    "start_time": VESTING_START_TIME,
                    "end_time": VESTING_END_TIME,
                }
                all_batch_data.append(batch_info)
            else:
                try:
                    tx_hash = send_setup_batch_transaction(
                        TOKEN_ADDRESS, batch_users, batch_amounts, batch_num + 1
                    )
                    all_transaction_hashes.append(("setup", tx_hash))
                    time.sleep(2)
                except Exception as e:
                    print(f"Error processing setup batch {batch_num + 1}: {e}")
                    save_progress(all_transaction_hashes, batch_num)
                    raise

    if dry_run:
        save_dry_run_summary(all_batch_data, existing_updates, new_setups)
    else:
        save_progress(all_transaction_hashes, len(all_batch_data))
        print("\nAll batches processed successfully!")
        print(f"Total transactions: {len(all_transaction_hashes)}")
        print(
            f"Reset transactions: {sum(1 for op, _ in all_transaction_hashes if op == 'reset')}"
        )
        print(
            f"Setup transactions: {sum(1 for op, _ in all_transaction_hashes if op == 'setup')}"
        )


def save_dry_run_summary(
    all_batch_data: List[dict],
    existing_updates: List[Tuple[str, int]],
    new_setups: List[Tuple[str, int]],
):
    """
    Save dry run summary to files for review
    """
    timestamp = int(time.time())

    # Save detailed batch information
    batch_file = f"dry_run_batches_{timestamp}.json"
    with open(batch_file, "w") as f:
        json.dump(all_batch_data, f, indent=2)

    # Save summary CSV
    summary_file = f"dry_run_summary_{timestamp}.csv"
    with open(summary_file, "w", newline="") as f:
        fieldnames = ["user", "operation", "amount", "batch_number"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for batch_info in all_batch_data:
            batch_num = batch_info["batch_number"]
            operation = batch_info["operation"]
            for user, amount in batch_info["user_updates"]:
                writer.writerow(
                    {
                        "user": user,
                        "operation": operation,
                        "amount": amount,
                        "batch_number": batch_num,
                    }
                )

    # Print summary statistics
    total_users = len(existing_updates) + len(new_setups)
    total_batches = len(all_batch_data)

    print("\n" + "=" * 50)
    print("DRY RUN SUMMARY")
    print("=" * 50)
    print(f"Total users to process: {total_users}")
    print(f"  - Existing plans to update: {len(existing_updates)}")
    print(f"  - New plans to create: {len(new_setups)}")
    print(f"Total batches: {total_batches}")
    print(f"Token address: {TOKEN_ADDRESS}")
    print(f"Vesting contract: {VESTING_CONTRACT_ADDRESS}")

    if new_setups:
        print("\nNew vesting plans configuration:")
        print(
            f"  - Start time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(VESTING_START_TIME))}"
        )
        print(
            f"  - End time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(VESTING_END_TIME))}"
        )

    print(f"\nDetailed batch data saved to: {batch_file}")
    print(f"Summary CSV saved to: {summary_file}")
    print("\nReview these files before running with dry_run=False")
    print("To execute these changes, run without --dry-run flag")


def save_progress(transaction_hashes: List[Tuple[str, str]], batches_processed: int):
    """
    Save transaction hashes to a file for record keeping
    """
    output_file = f"vesting_update_txs_{int(time.time())}.json"

    # Organize hashes by operation type
    reset_txs = [tx for op, tx in transaction_hashes if op == "reset"]
    setup_txs = [tx for op, tx in transaction_hashes if op == "setup"]

    with open(output_file, "w") as f:
        json.dump(
            {
                "all_transaction_hashes": transaction_hashes,
                "reset_transactions": reset_txs,
                "setup_transactions": setup_txs,
                "batches_processed": batches_processed,
                "timestamp": int(time.time()),
            },
            f,
            indent=2,
        )
    print(f"Progress saved to {output_file}")


def create_sample_input_file():
    """
    Create a sample CSV input file for testing
    """
    import csv

    sample_data = [
        {
            "user": "0x1234567890123456789012345678901234567890",
            "amount": "1000000000000000000",
        },
        {
            "user": "0x2345678901234567890123456789012345678901",
            "amount": "2000000000000000000",
        },
        {
            "user": "0x3456789012345678901234567890123456789012",
            "amount": "1500000000000000000",
        },
        # Add more users here
    ]

    with open("vesting_updates_input.csv", "w", newline="") as f:
        fieldnames = ["user", "amount"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)

        writer.writeheader()
        writer.writerows(sample_data)

    print("Sample CSV input file created: vesting_updates_input.csv")


if __name__ == "__main__":
    import sys

    # Check command line arguments
    dry_run = False
    if len(sys.argv) > 1 and sys.argv[1] == "--dry-run":
        dry_run = True

    # Uncomment to create a sample input file
    create_sample_input_file()

    # Configuration
    input_file = "vesting_updates_input.csv"  # Your CSV input file
    batch_size = 300

    # Check if input file exists
    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found!")
        print("Please create a CSV file with 'user' and 'amount' columns.")
        sys.exit(1)

    print("Starting vesting plan updates...")
    print(f"Input file: {input_file}")
    print(f"Batch size: {batch_size}")
    print(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")

    if not dry_run:
        response = input("\nThis will send REAL transactions. Continue? (yes/no): ")
        if response.lower() != "yes":
            print("Aborted.")
            sys.exit(0)

    # Run the update
    update_vesting_plans(input_file, batch_size=batch_size, dry_run=dry_run)
