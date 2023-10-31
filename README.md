# Simple EVM TPS tool

```shell
git clone https://github.com/paritytech/evm-tps.git
cd evm-tps

yarn
```

## Setup:

Change network's parameters ("local") in [hardhat.config.json](hardhat.config.ts):

Change test's parameters in [data/config.json](./data/config.json) for the different use-cases:

### EVM thoughput

-   **Erc20**: Use the following config file:

```
rm data/config.json
ln -s data/config.erc20.json data/config.json
```

Inside `config.erc20.json`, the variable `quantity` will determine how many transactions are sent.

-   **Erc721**: Use the followig config file:

```
rm data/config.json
ln -s data/config.erc721.json data/config.json
```

After setting the desired `data/config.json`, run:

```bash
$ yarn evm
```

This will perform an initial setup. After this initiall setup is done and the script outputs (Make sure that the blocks are empty showing (~000%), meaning that the setup is complete).

```
[BlockTracker] Block: 0381 | txns: 0000 | gasUsed: 000000000 (~000%) [gasPrice: 0M | pool: 00000]
> Listening at http://0.0.0.0:8181
```

In a different terminal run:

```bash
$ curl -X GET "http://0.0.0.0:8181/auto"
```

This will start the transaction sending and the first script should start showing activity inside the blocks

### Substrate thoughput

-   **Native asset (pallet-balances)**: Use the following `config.json`:

```
$ rm data/config.json
$ ln -s data/config.balances.json data/config.json
```

-   **Pallet-assets**: Use the following `config.json`:

```
$ rm data/config.json
$ ln -s data/config.assets.json data/config.json
```

-   **Pallet-nfts**: Use the following `config.json`:

```
$ rm data/config.json
$ ln -s data/config.nfts.json data/config.json
```

This will perform an initial setup. After this initiall setup is done and the script outputs.

```
[BlockTracker] Block: 0381 | txns: 0000 | gasUsed: 000000000 (~000%) [gasPrice: 0M | pool: 00000]
> Listening at http://0.0.0.0:8181
```

In a different terminal run:

```bash
curl -X GET "http://0.0.0.0:8181/auto"
```

This will start the transaction sending and the first script should start showing activity inside the blocks.

## Deployer:

1. CI pre funded EVM Account (Frontier)

```json
  "variant": "frontier",
  "deployer": {
    "address": "0x6Be02d1d3665660d22FF9624b7BE0551ee1Ac91b",
    "privateKey": "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342"
  },
```

2. Alith (Substrate/Frontier)

```json
  "variant": "frontier",
  "deployer": {
    "address": "0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac",
    "privateKey": "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133"
  },
```

3. Alice (Substrate)

```json
  "variant": "substrate",
  "deployer": {
    "address": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    "privateKey": "0xe5be9a5092b81bca64be81d212e7f2f9eba183bb7a90954f7b76361f6edb5c0a"
  },
```
