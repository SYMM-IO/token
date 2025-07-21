import csv
import json
import logging
import sys
from datetime import datetime
from multicallable import Multicallable
from web3 import Web3

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("vesting_script.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)

# Configuration
TOKEN_ADDRESS = ""
VESTING_CONTRACT = ""
PENDING_CONTRACT = ""  # New contract for pending amounts
NEW_START_TIME = 1749996000
NEW_END_TIME = 1758386880
EXECUTION_TIMESTAMP = 1749996000
RPC_URL = "https://base.drpc.org"
BATCH_SIZE = 150  # Batch size for setup transactions

# Initialize Web3
logger.info("Initializing Web3 connection...")
w3 = Web3(Web3.HTTPProvider(RPC_URL))

# Check connection
if w3.is_connected():
    logger.info(f"Successfully connected to {RPC_URL}")
    logger.info(f"Latest block: {w3.eth.block_number}")
else:
    logger.error(f"Failed to connect to {RPC_URL}")
    sys.exit(1)

# Log configuration
logger.info("=== Configuration ===")
logger.info(f"Token Address: {TOKEN_ADDRESS}")
logger.info(f"Vesting Contract: {VESTING_CONTRACT}")
logger.info(f"Pending Contract: {PENDING_CONTRACT}")
logger.info(
    f"New Start Time: {NEW_START_TIME} ({datetime.fromtimestamp(NEW_START_TIME)})"
)
logger.info(f"New End Time: {NEW_END_TIME} ({datetime.fromtimestamp(NEW_END_TIME)})")
logger.info(
    f"Execution Timestamp: {EXECUTION_TIMESTAMP} ({datetime.fromtimestamp(EXECUTION_TIMESTAMP)})"
)
logger.info(f"Batch Size for Setup Transactions: {BATCH_SIZE}")

# Minimal ABI for vesting contract
VESTING_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "", "type": "address"},
            {"internalType": "address", "name": "", "type": "address"},
        ],
        "name": "vestingPlans",
        "outputs": [
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
            {"internalType": "uint256", "name": "claimedAmount", "type": "uint256"},
            {"internalType": "uint256", "name": "startTime", "type": "uint256"},
            {"internalType": "uint256", "name": "endTime", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    }
]

# ABI for pending amounts contract
PENDING_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "user", "type": "address"},
        ],
        "name": "pendingAmount",
        "outputs": [
            {"internalType": "uint256", "name": "", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    }
]


def calculate_future_locked_amount(vesting_plan, future_timestamp):
    """Calculate the locked amount at a future timestamp."""
    amount, claimed_amount, start_time, end_time = vesting_plan

    logger.debug(
        f"Calculating future locked amount for plan: amount={amount}, claimed={claimed_amount}, start={start_time}, end={end_time}"
    )

    if amount == 0:
        logger.debug("Plan has zero amount, returning 0")
        return 0

    # Calculate unlocked amount at future timestamp
    if future_timestamp >= end_time:
        unlocked = amount
        logger.debug(f"Future timestamp >= end time, fully unlocked: {unlocked}")
    elif future_timestamp <= start_time:
        unlocked = 0
        logger.debug(f"Future timestamp <= start time, nothing unlocked: {unlocked}")
    else:
        duration = end_time - start_time
        elapsed = future_timestamp - start_time
        unlocked = (amount * elapsed) // duration
        logger.debug(
            f"Partial unlock: duration={duration}, elapsed={elapsed}, unlocked={unlocked}"
        )

    locked = amount - unlocked
    logger.debug(f"Final locked amount: {locked}")
    return locked


def batch_list(input_list, batch_size):
    """Split a list into batches of specified size."""
    for i in range(0, len(input_list), batch_size):
        yield input_list[i : i + batch_size]


def main():
    logger.info("=== Starting Vesting Plan Setup ===")

    # Initialize multicallable contracts
    logger.info("Initializing multicallable contracts...")
    try:
        vesting_contract = Multicallable(VESTING_CONTRACT, VESTING_ABI, w3)
        pending_contract = Multicallable(PENDING_CONTRACT, PENDING_ABI, w3)
        logger.info("Multicallable contracts initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize multicallable contracts: {e}")
        return

    # Read CSV
    logger.info("Reading CSV file...")
    users_data = []
    try:
        with open("users_amounts.csv", "r") as file:
            reader = csv.reader(file)
            header = next(reader)  # Skip header
            logger.info(f"CSV header: {header}")

            row_count = 0
            for row in reader:
                try:
                    user = w3.to_checksum_address(row[0])
                    amount = int(float(row[1]))  # Convert to float first, then to int
                    users_data.append((user, amount))
                    row_count += 1

                    if row_count <= 5:  # Log first 5 entries for verification
                        logger.info(f"Row {row_count}: User={user}, Amount={amount}")
                    elif row_count % 50 == 0:  # Log every 50th entry
                        logger.info(f"Processed {row_count} rows...")

                except Exception as e:
                    logger.error(f"Error processing row {row_count + 1}: {row} - {e}")
                    continue

            logger.info(f"Successfully read {len(users_data)} user records from CSV")

    except FileNotFoundError:
        logger.error("CSV file 'users_amounts.csv' not found")
        return
    except Exception as e:
        logger.error(f"Error reading CSV file: {e}")
        return

    if not users_data:
        logger.error("No valid user data found in CSV")
        return

    # Extract users for batch call
    all_users = [user for user, _ in users_data]
    logger.info(f"Prepared {len(all_users)} users for batch vesting plan fetch")

    # Batch fetch all vesting plans
    logger.info("Fetching existing vesting plans...")

    try:
        # Create multicall parameters for vesting plans
        vesting_call_params = [(TOKEN_ADDRESS, user) for user in all_users]
        logger.info(f"Created {len(vesting_call_params)} vesting multicall parameters")

        # Calculate batch size
        batch_size = len(all_users) // 100 + 1
        logger.info(f"Using batch size: {batch_size}")

        # Execute batch call for vesting plans
        logger.info("Executing vesting plans multicall...")
        vesting_results = vesting_contract.vestingPlans(vesting_call_params).call(
            n=batch_size, progress_bar=True
        )
        logger.info(f"Successfully fetched {len(vesting_results)} vesting plans")

    except Exception as e:
        logger.error(f"Error during vesting multicall execution: {e}")
        return

    # Identify users without vesting plans
    no_vesting_users = []
    for i, (user, _) in enumerate(users_data):
        if vesting_results[i][0] == 0:  # No existing plan
            no_vesting_users.append(user)

    # Batch fetch pending amounts for users without vesting plans
    pending_amounts = {}
    if no_vesting_users:
        logger.info(
            f"Fetching pending amounts for {len(no_vesting_users)} users without vesting plans..."
        )
        try:
            # Create multicall parameters for pending amounts
            pending_call_params = no_vesting_users

            # Execute batch call for pending amounts
            logger.info("Executing pending amounts multicall...")
            pending_results = pending_contract.pendingAmount(pending_call_params).call(
                n=len(no_vesting_users) // 100 + 1, progress_bar=True
            )

            # Map results to users
            for i, user in enumerate(no_vesting_users):
                pending_amounts[user] = pending_results[i]
                if pending_results[i] > 0:
                    logger.info(
                        f"User {user} has pending amount: {pending_results[i] / 1e18:,}"
                    )

            logger.info(
                f"Successfully fetched pending amounts for {len(no_vesting_users)} users"
            )

        except Exception as e:
            logger.error(f"Error during pending amounts multicall execution: {e}")
            # Initialize with zeros if fetch fails
            for user in no_vesting_users:
                pending_amounts[user] = 0

    # Process results
    logger.info("Processing results...")
    setup_users = []
    setup_amounts = []
    reset_users = []
    reset_amounts = []

    existing_plans_count = 0
    new_plans_count = 0
    total_new_vested_amount = 0
    total_setup_new_amount = 0
    total_reset_new_amount = 0
    total_pending_amount = 0

    logger.info("=== Individual Address Processing ===")

    for i, (user, csv_amount) in enumerate(users_data):
        try:
            plan = vesting_results[i]
            user_index = i + 1

            total_new_vested_amount += csv_amount

            if plan[0] == 0:  # No existing plan
                # Check for pending amount
                pending = pending_amounts.get(user, 0)
                total_amount = csv_amount + pending

                setup_users.append(user)
                setup_amounts.append(total_amount)
                new_plans_count += 1
                total_setup_new_amount += csv_amount
                total_pending_amount += pending

                if pending > 0:
                    logger.info(
                        f"[{user_index:3d}/{len(users_data)}] NEW - {user} | CSV Amount: {csv_amount / 1e18:,} | Pending: {pending / 1e18:,} | Total: {total_amount / 1e18:,} | Action: Setup"
                    )
                else:
                    logger.info(
                        f"[{user_index:3d}/{len(users_data)}] NEW - {user} | Amount: {csv_amount / 1e18:,} | Action: Setup"
                    )

            else:
                existing_plans_count += 1

                # Extract existing plan details
                existing_amount, claimed_amount, start_time, end_time = plan

                # Calculate future locked amount
                future_locked = calculate_future_locked_amount(
                    plan, EXECUTION_TIMESTAMP
                )
                total_amount = future_locked + csv_amount

                reset_users.append(user)
                reset_amounts.append(total_amount)
                total_reset_new_amount += csv_amount

                claimed_pct = (
                    (claimed_amount / existing_amount * 100)
                    if existing_amount > 0
                    else 0
                )

                logger.info(
                    f"[{user_index:3d}/{len(users_data)}] RESET - {user} | Existing: {existing_amount / 1e18:,} | Claimed: {claimed_amount / 1e18:,} ({claimed_pct:.1f}%) | Future Locked: {future_locked / 1e18:,} | New: {csv_amount / 1e18:,} | Total: {total_amount / 1e18:,}"
                )

        except Exception as e:
            logger.error(f"[{user_index:3d}/{len(users_data)}] ERROR - {user}: {e}")
            continue

    logger.info("=== Processing Summary ===")
    logger.info(f"Total users processed: {len(users_data)}")
    logger.info(f"Users with existing plans: {existing_plans_count}")
    logger.info(f"Users needing new plans: {new_plans_count}")
    logger.info(f"Users for setup transaction: {len(setup_users)}")
    logger.info(f"Users for reset transaction: {len(reset_users)}")
    logger.info("")
    logger.info("=== Vesting Amount Summary ===")
    logger.info(
        f"Total NEW vested amount (setup users): {total_setup_new_amount / 1e18:,}"
    )
    logger.info(
        f"Total NEW vested amount (reset users): {total_reset_new_amount / 1e18:,}"
    )
    logger.info(
        f"Total NEW vested amount (all users): {total_new_vested_amount / 1e18:,}"
    )
    logger.info(f"Total pending amount included: {total_pending_amount / 1e18:,}")
    logger.info(f"Total transaction amount (setup): {sum(setup_amounts) / 1e18:,}")
    logger.info(f"Total transaction amount (reset): {sum(reset_amounts) / 1e18:,}")

    # Generate calldata using web3py (since multicallable is for reading)
    logger.info("Generating transaction calldata...")

    try:
        vesting_interface = w3.eth.contract(
            address=VESTING_CONTRACT,
            abi=[
                {
                    "inputs": [
                        {"internalType": "address", "name": "token", "type": "address"},
                        {
                            "internalType": "uint256",
                            "name": "startTime",
                            "type": "uint256",
                        },
                        {
                            "internalType": "uint256",
                            "name": "endTime",
                            "type": "uint256",
                        },
                        {
                            "internalType": "address[]",
                            "name": "users",
                            "type": "address[]",
                        },
                        {
                            "internalType": "uint256[]",
                            "name": "amounts",
                            "type": "uint256[]",
                        },
                    ],
                    "name": "setupVestingPlans",
                    "outputs": [],
                    "stateMutability": "nonpayable",
                    "type": "function",
                },
                {
                    "inputs": [
                        {"internalType": "address", "name": "token", "type": "address"},
                        {
                            "internalType": "address[]",
                            "name": "users",
                            "type": "address[]",
                        },
                        {
                            "internalType": "uint256[]",
                            "name": "amounts",
                            "type": "uint256[]",
                        },
                    ],
                    "name": "resetVestingPlans",
                    "outputs": [],
                    "stateMutability": "nonpayable",
                    "type": "function",
                },
            ],
        )

        # Transaction(s) for setupVestingPlans - now in batches
        if setup_users:
            logger.info(
                f"Generating setupVestingPlans transactions in batches of {BATCH_SIZE}..."
            )

            # Calculate number of batches
            num_batches = (len(setup_users) + BATCH_SIZE - 1) // BATCH_SIZE
            logger.info(f"Will create {num_batches} setupVestingPlans transactions")

            # Create batches
            user_batches = list(batch_list(setup_users, BATCH_SIZE))
            amount_batches = list(batch_list(setup_amounts, BATCH_SIZE))

            for batch_index, (batch_users, batch_amounts) in enumerate(
                zip(user_batches, amount_batches)
            ):
                batch_num = batch_index + 1
                batch_total_amount = sum(batch_amounts) / 1e18

                setup_calldata = vesting_interface.encode_abi(
                    "setupVestingPlans",
                    args=[
                        TOKEN_ADDRESS,
                        NEW_START_TIME,
                        NEW_END_TIME,
                        batch_users,
                        batch_amounts,
                    ],
                )

                logger.info(
                    f"\n=== Transaction {batch_num}: setupVestingPlans (Batch {batch_num}/{num_batches}) ==="
                )
                logger.info(f"To: {VESTING_CONTRACT}")
                logger.info(f"Users count: {len(batch_users)}")
                logger.info(f"Batch total amount: {batch_total_amount:,}")
                logger.info(f"Calldata length: {len(setup_calldata)} bytes")
                print(f"\nBatch {batch_num} Calldata: {setup_calldata}")

                # Optionally save each batch calldata to a separate file
                with open(f"setup_batch_{batch_num}_calldata.txt", "w") as f:
                    f.write(f"To: {VESTING_CONTRACT}\n")
                    f.write(f"Users count: {len(batch_users)}\n")
                    f.write(f"Batch total amount: {batch_total_amount:,}\n")
                    f.write(f"Calldata: {setup_calldata}\n")
                logger.info(
                    f"Saved batch {batch_num} calldata to setup_batch_{batch_num}_calldata.txt"
                )

        else:
            logger.info("No users require setupVestingPlans transaction")

        # Transaction for resetVestingPlans (keeping as single transaction)
        if reset_users:
            logger.info("\nGenerating resetVestingPlans transaction...")
            reset_calldata = vesting_interface.encode_abi(
                "resetVestingPlans", args=[TOKEN_ADDRESS, reset_users, reset_amounts]
            )

            logger.info("\n=== Reset Transaction: resetVestingPlans ===")
            logger.info(f"To: {VESTING_CONTRACT}")
            logger.info(f"Users count: {len(reset_users)}")
            logger.info(f"Total amount: {sum(reset_amounts) / 1e18:,}")
            logger.info(f"Calldata length: {len(reset_calldata)} bytes")
            print(f"\nReset Calldata: {reset_calldata}")

            # Save reset calldata to file
            with open("reset_calldata.txt", "w") as f:
                f.write(f"To: {VESTING_CONTRACT}\n")
                f.write(f"Users count: {len(reset_users)}\n")
                f.write(f"Total amount: {sum(reset_amounts) / 1e18:,}\n")
                f.write(f"Calldata: {reset_calldata}\n")
            logger.info("Saved reset calldata to reset_calldata.txt")
        else:
            logger.info("No users require resetVestingPlans transaction")

    except Exception as e:
        logger.error(f"Error generating transaction calldata: {e}")
        return

    logger.info("\n=== Script completed successfully ===")

    # Final summary
    if setup_users:
        logger.info(f"\nSetup transactions summary:")
        logger.info(f"- Total setup users: {len(setup_users)}")
        logger.info(f"- Number of batches: {num_batches}")
        logger.info(f"- Batch size: {BATCH_SIZE}")
        logger.info(f"- Last batch size: {len(user_batches[-1])}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Script interrupted by user")
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
