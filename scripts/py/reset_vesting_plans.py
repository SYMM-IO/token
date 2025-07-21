import json
import os
import csv
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

# CSV Input Format:
# The CSV file should have two columns: 'user' and 'amount'
# Example:
# user,amount
# 0x1234567890123456789012345678901234567890,1000000000000000000
# 0x2345678901234567890123456789012345678901,2000000000000000000

# Initialize Web3
w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(PRIVATE_KEY)

# Vesting contract ABI (minimal ABI with just the functions we need)
VESTING_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "user", "type": "address"},
            {"internalType": "address", "name": "token", "type": "address"}
        ],
        "name": "getLockedAmountsForToken",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "address[]", "name": "users", "type": "address[]"},
            {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"}
        ],
        "name": "resetVestingPlans",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]

def load_user_updates(filename: str) -> List[Tuple[str, int]]:
    """
    Load user addresses and amounts to add from a CSV file.
    Expected format: CSV with columns 'user' and 'amount'
    """
    import csv
    
    user_updates = []
    
    with open(filename, 'r') as f:
        reader = csv.DictReader(f)
        
        # Check if required columns exist
        if 'user' not in reader.fieldnames or 'amount' not in reader.fieldnames:
            raise ValueError("CSV must have 'user' and 'amount' columns")
        
        for row in reader:
            user = w3.to_checksum_address(row['user'].strip())
            amount = int(row['amount'].strip())
            user_updates.append((user, amount))
    
    print(f"Loaded {len(user_updates)} user updates from CSV")
    return user_updates

def get_current_locked_amounts(users: List[str], token: str) -> List[int]:
    """
    Get current locked amounts for all users using multicallable
    """
    print(f"Fetching current locked amounts for {len(users)} users...")
    
    # Create multicallable contract instance
    contract = Multicallable(
        w3.to_checksum_address(VESTING_CONTRACT_ADDRESS), 
        VESTING_ABI, 
        w3
    )
    
    # Prepare calls for getLockedAmountsForToken
    # We need to pass both user and token for each call
    calls = []
    for user in users:
        calls.append((user, token))
    
    # Execute multicall
    locked_amounts = contract.getLockedAmountsForToken(calls).call(
        n=len(users) // 200 + 1,  # Split into chunks of 200
        progress_bar=True
    )
    
    return locked_amounts

def prepare_update_data(user_updates: List[Tuple[str, int]], current_locked: List[int]) -> List[Tuple[str, int]]:
    """
    Combine current locked amounts with amounts to add
    """
    updated_data = []
    
    for i, (user, amount_to_add) in enumerate(user_updates):
        current_amount = current_locked[i]
        new_amount = current_amount + amount_to_add
        updated_data.append((user, new_amount))
        print(f"User {user}: {current_amount} + {amount_to_add} = {new_amount}")
    
    return updated_data

def send_batch_transaction(token: str, users: List[str], amounts: List[int], batch_num: int) -> str:
    """
    Send a transaction to reset vesting plans for a batch of users
    """
    contract = w3.eth.contract(
        address=w3.to_checksum_address(VESTING_CONTRACT_ADDRESS),
        abi=VESTING_ABI
    )
    
    # Build transaction
    nonce = w3.eth.get_transaction_count(account.address)
    
    tx = contract.functions.resetVestingPlans(
        token,
        users,
        amounts
    ).build_transaction({
        'from': account.address,
        'nonce': nonce,
        'gas': 5000000,  # Adjust based on your needs
        'gasPrice': w3.eth.gas_price,
        'chainId': w3.eth.chain_id
    })
    
    # Sign and send transaction
    signed_tx = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    
    print(f"Batch {batch_num} transaction sent: {tx_hash.hex()}")
    
    # Wait for confirmation
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    
    if receipt['status'] == 1:
        print(f"Batch {batch_num} transaction successful!")
    else:
        print(f"Batch {batch_num} transaction failed!")
        raise Exception(f"Transaction failed for batch {batch_num}")
    
    return tx_hash.hex()

def update_vesting_plans(input_file: str, batch_size: int = 300):
    """
    Main function to update vesting plans from a CSV file
    """
    # Load user updates
    user_updates = load_user_updates(input_file)
    print(f"Loaded {len(user_updates)} user updates")
    
    # Extract users list
    users = [user for user, _ in user_updates]
    
    # Get current locked amounts
    current_locked = get_current_locked_amounts(users, TOKEN_ADDRESS)
    
    # Prepare updated data
    updated_data = prepare_update_data(user_updates, current_locked)
    
    # Split into batches and send transactions
    total_batches = (len(updated_data) + batch_size - 1) // batch_size
    print(f"\nProcessing {total_batches} batches of up to {batch_size} users each...")
    
    transaction_hashes = []
    
    for batch_num in range(total_batches):
        start_idx = batch_num * batch_size
        end_idx = min((batch_num + 1) * batch_size, len(updated_data))
        
        batch_data = updated_data[start_idx:end_idx]
        batch_users = [user for user, _ in batch_data]
        batch_amounts = [amount for _, amount in batch_data]
        
        print(f"\nProcessing batch {batch_num + 1}/{total_batches} ({len(batch_data)} users)...")
        
        try:
            tx_hash = send_batch_transaction(TOKEN_ADDRESS, batch_users, batch_amounts, batch_num + 1)
            transaction_hashes.append(tx_hash)
            
            # Wait a bit between transactions to avoid nonce issues
            if batch_num < total_batches - 1:
                time.sleep(2)
                
        except Exception as e:
            print(f"Error processing batch {batch_num + 1}: {e}")
            # Save progress
            save_progress(transaction_hashes, batch_num)
            raise
    
    # Save all transaction hashes
    save_progress(transaction_hashes, total_batches)
    print(f"\nAll batches processed successfully! Total transactions: {len(transaction_hashes)}")

def save_progress(transaction_hashes: List[str], batches_processed: int):
    """
    Save transaction hashes to a file for record keeping
    """
    output_file = f"vesting_update_txs_{int(time.time())}.json"
    with open(output_file, 'w') as f:
        json.dump({
            'transaction_hashes': transaction_hashes,
            'batches_processed': batches_processed,
            'timestamp': int(time.time())
        }, f, indent=2)
    print(f"Progress saved to {output_file}")

def create_sample_input_file():
    """
    Create a sample CSV input file for testing
    """
    import csv
    
    sample_data = [
        {"user": "0x1234567890123456789012345678901234567890", "amount": "1000000000000000000"},
        {"user": "0x2345678901234567890123456789012345678901", "amount": "2000000000000000000"},
        {"user": "0x3456789012345678901234567890123456789012", "amount": "1500000000000000000"},
        # Add more users here
    ]
    
    with open("vesting_updates_input.csv", 'w', newline='') as f:
        fieldnames = ['user', 'amount']
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        
        writer.writeheader()
        writer.writerows(sample_data)
    
    print("Sample CSV input file created: vesting_updates_input.csv")

if __name__ == "__main__":
    # Uncomment to create a sample input file
    create_sample_input_file()
    
    # Run the update
    input_file = "vesting_updates_input.csv"  # Your CSV input file
    update_vesting_plans(input_file, batch_size=300)