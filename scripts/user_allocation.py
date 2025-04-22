import json
import os

import requests
from multicallable import Multicallable
from web3 import Web3

SUBGRAPH_URL = "https://api.studio.thegraph.com/query/85206/allocated/version/latest"

rpc = "https://base-rpc.publicnode.com"
rpc = "https://base.llamarpc.com"
rpc = "https://base.drpc.org"

contract_address = "0x232b72527e3692E78d7f6D73634fc4E100E31f80"

w3 = Web3(Web3.HTTPProvider(rpc))


def fetch_all_users():
    all_users = set()
    last_id = ""
    while True:
        query = f"""
        {{
          batchAllocationsSets(orderBy: id, orderDirection: asc, first: 1000, where: {{id_gt: "{last_id}"}}) {{
            id
            users
          }}
        }}
        """
        response = requests.post(SUBGRAPH_URL, json={'query': query})
        data = response.json()
        sets = data["data"]["batchAllocationsSets"]

        if not sets:
            break

        for batch in sets:
            for user in batch["users"]:
                all_users.add(w3.to_checksum_address(user))

        last_id = sets[-1]["id"]

    return list(all_users)


users = fetch_all_users()
print(f"Fetched {len(users)} unique users.")

with open(f"{os.getcwd()}/abis/SymmAllocationClaimer.json", "r") as f:
    abi = json.load(f)

contract = Multicallable(w3.to_checksum_address(contract_address), abi, w3)
available = contract.userAllocations(users).call(n=len(users) // 200 + 1, progress_bar=True)
rows = {"Users": [], "Available": []}
for user, amount in zip(users, available):
    rows["Users"].append(user)
    rows["Available"].append(str(amount))
with open(f"{os.getcwd()}/user_available_symm.json", "w") as f:
    f.write(json.dumps(rows, indent=2))
