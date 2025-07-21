import csv
import json

from web3 import Web3

# --- Config ---
rpc_url = "https://1rpc.io/base"
PRIVATE_KEY = ""
upsert_manager_address = ""

# --- Setup ---
w3 = Web3(Web3.HTTPProvider(rpc_url))
account = w3.eth.account.from_key(PRIVATE_KEY)

with open("vesting_upsert_manager.json") as f:
    upsert_manager_abi = json.load(f)

upsert_manager_contract = w3.eth.contract(address=w3.to_checksum_address(upsert_manager_address),
                                          abi=upsert_manager_abi)

# --- Call Data ---
token = w3.to_checksum_address("0x800822d361335b4d5F352Dac293cA4128b5B605f")
users = []
amounts = []
with open("input.csv", newline="") as csvfile:
    reader = csv.DictReader(csvfile)
    for row in reader:
        user = w3.to_checksum_address(row["user"].strip())
        amount_str = row["amount"].strip()
        if not amount_str:
            continue
        amount = int(amount_str)
        users.append(user)
        amounts.append(amount)

print(f"Loaded {len(users)} users from CSV")

# --- Send tx ---
batch_size = 100
for i in range(len(users) // batch_size + 1):
    chunk_users = users[batch_size * i:batch_size * (i + 1)]
    chunk_amounts = amounts[batch_size * i:batch_size * (i + 1)]

    if not chunk_users:
        continue

    nonce = w3.eth.get_transaction_count(account.address)

    estimated_gas = upsert_manager_contract.functions.upsertVestingPlans(
        token,
        chunk_users,
        chunk_amounts
    ).estimate_gas({'from': account.address})

    tx = upsert_manager_contract.functions.upsertVestingPlans(
        token,
        chunk_users,
        chunk_amounts
    ).build_transaction({
        'chainId': w3.eth.chain_id,
        'from': account.address,
        'nonce': nonce,
        'gas': int(estimated_gas * 1.2),
        'gasPrice': int(w3.eth.gas_price * 1.2),
    })

    signed_tx = w3.eth.account.sign_transaction(tx, private_key=PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)

    print("Transaction sent:", w3.to_hex(tx_hash))
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    print("Transaction confirmed.", receipt)

print("Finished successfully")
