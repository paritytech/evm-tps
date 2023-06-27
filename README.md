# Simple EVM TPS tool

```shell
git clone https://github.com/arturgontijo/evm-tps.git
cd evm-tps

yarn
```

Change network's parameters ("local") in [hardhat.config.json](hardhat.config.ts):

Change test's parameters in [config.json](config.json):

1. This will deploy the ERC20 contract and will send 30,000 `transferLoop()` transactions, asserting final Other's token balance:
```json
{
    "variant": "substrate",
    "senders": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E000"],
    "receivers": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E005"],
    "sendRawTransaction": true,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasPrice": "",
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 2,
    "txpoolCheckInterval": 1000,
    "txpoolCheckDelay": 250,
    "delay": 0,
    "estimate": false
}
```

2. This one already has the token deployed at `tokenAddress`, so it will only send 30,000 `transferLoop()` (5 * `transfer()`) transactions + tokenAssert:
```json
{
    "variant": "substrate",
    "senders": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E000"],
    "receivers": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E005"],
    "sendRawTransaction": true,
    "tokenAddress": "0x030c5D377E202F52CF30b7f855e09aC0589D53ab",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 5,
    "tokenAssert": true,
    "transactions": 30000,
    "gasPrice": "",
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 2,
    "txpoolCheckInterval": 1000,
    "txpoolCheckDelay": 250,
    "delay": 0,
    "estimate": false
}
```


3. This one has a `transfer()` hardcoded in the `payloads` field:
```json
{
    "variant": "substrate",
    "senders": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E000"],
    "receivers": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E005"],
    "sendRawTransaction": true,
    "tokenAddress": "0x030c5D377E202F52CF30b7f855e09aC0589D53ab",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": true,
    "transactions": 30000,
    "gasPrice": "",
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 2,
    "txpoolCheckInterval": 1000,
    "txpoolCheckDelay": 250,
    "delay": 0,
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
    "variant": "substrate",
    "senders": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"],
    "receivers": ["0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E005"],
    "sendRawTransaction": true,
    "tokenAddress": "",
    "tokenMethod": "transferLoop",
    "tokenAmountToMint": 1000000000,
    "tokenTransferMultiplier": 1,
    "tokenAssert": false,
    "transactions": 30000,
    "gasPrice": "",
    "gasLimit": "200000",
    "txpoolMaxLength": -1,
    "txpoolMultiplier": 2,
    "txpoolCheckInterval": 1000,
    "txpoolCheckDelay": 250,
    "delay": 0,
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

To run the script:

```shell
npx hardhat run scripts/tps.ts --network local
```

To run it with a different `config.json` file (eg `config2.json`):

```shell
EVM_TPS_CONFIG="path/to/config2.json" npx hardhat run scripts/tps.ts --network local
```
