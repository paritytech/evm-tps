# Simple EVM TPS tool

```shell
git clone https://github.com/paritytech/evm-tps.git
cd evm-tps

yarn
```

Change network's parameters ("local") in [hardhat.config.json](hardhat.config.ts):

Change test's parameters in [data/config.json](./data/config.json):

1. This will deploy the ERC20 contract and will prepare a server to send `transferLoop()` transactions, asserting final Other's token balance:
```json
{
    "tpsServerHost": "0.0.0.0",
    "tpsServerPort": 8181,
    "variant": "substrate",
    "deployer": {
        "address": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
        "privateKey": "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"
    },
    "fundSenders": true,
    "accounts": 100,
    "workers": 80,
    "sendRawTransaction": true,
    "timeout": 15000,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 3,
    "checkersInterval": 250,
    "estimate": false
}
```

2. This one already has the token deployed at `tokenAddress`, so it will wait to send `transferLoop()` (5 * `transfer()`) transactions + tokenAssert:
```json
{
    "tpsServerHost": "0.0.0.0",
    "tpsServerPort": 8181,
    "variant": "substrate",
    "deployer": {
        "address": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
        "privateKey": "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"
    },
    "fundSenders": true,
    "accounts": 100,
    "workers": 80,
    "sendRawTransaction": true,
    "timeout": 15000,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 3,
    "checkersInterval": 250,
    "estimate": false
}
```


3. This one has a `transfer()` hardcoded in the `payloads` field:
```json
{
    "tpsServerHost": "0.0.0.0",
    "tpsServerPort": 8181,
    "variant": "substrate",
    "deployer": {
        "address": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
        "privateKey": "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"
    },
    "fundSenders": true,
    "accounts": 100,
    "workers": 80,
    "sendRawTransaction": true,
    "timeout": 15000,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 3,
    "checkersInterval": 250,
    "estimate": false,
    "payloads": [
        {
            "data": "0xa9059cbb000000000000000000000000ea8d69db60401a766e1083beba3a34cafa13151c0000000000000000000000000000000000000000000000000000000000000001",
            "from": "0x48A78AeA1c4F8C24EDfE7FE0973F05D3f3d1763C",
            "to": "0x030c5D377E202F52CF30b7f855e09aC0589D53ab"
        }
    ]
}
```

4. This one sends ETH (`send()`) via `payloads` field and assert the destination `"to"` ETH balance at the end:
```json
{
    "tpsServerHost": "0.0.0.0",
    "tpsServerPort": 8181,
    "variant": "substrate",
    "deployer": {
        "address": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
        "privateKey": "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"
    },
    "fundSenders": true,
    "accounts": 100,
    "workers": 80,
    "sendRawTransaction": true,
    "timeout": 15000,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 3,
    "checkersInterval": 250,
    "estimate": false,
    "payloads": [
        {
            "from": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
            "to": "0xEA8D69Db60401A766e1083bebA3A34cAfa13151C",
            "value": "0x1414"
        }
    ]
}
```

To run the TPS server:

```shell
npx hardhat run scripts/tps-server.ts --network local
```

After the initial setup is done, you can trigger an "auto" run by:
```shell
curl -X GET "http://0.0.0.0:8181/auto"
```

That command will send `30,000` transactions to the target using `80` threads (set by `transactions` and `workers` in the [data/config.json](./data/config.json)).


Or sending requests via `artillery`/`wrk` to:
```shell
artillery quick --count 50 --num 500 http://0.0.0.0:8181/sendRawTransaction
```

That command will send 25,000 (`50` "users" sending `500` requests each) requests to `/sendRawTransaction`.

```
wrk -t 50 -c 50 -d 600 --latency --timeout 1m http://0.0.0.0:8181/sendRawTransaction
```

That command will spawn 50 threads to send requests to `/sendRawTransaction` in 600 seconds.

To run it using a different JSON files directory (other than `data/`) by setting `EVM_TPS_ROOT_DIR`:

```shell
EVM_TPS_ROOT_DIR="path/to/dir" npx hardhat run scripts/tps-server.ts --network local
```
