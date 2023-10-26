import { ApiPromise, WsProvider } from '@polkadot/api';
import { KeyringPair } from '@polkadot/keyring/types';
import {
    getBlockWithExtras,
    getDeployer,
    printNumberMap,
    readJSON,
    validTxHash,
} from '../utils/utils';
import fs from 'fs';
import { promisify } from 'util';
import express from 'express';
import BodyParser from 'body-parser';

const EVM_TPS_ROOT_DIR = process.env.ROOT_DIR || 'data';
const EVM_TPS_CONFIG_FILE = `${EVM_TPS_ROOT_DIR}/config.json`;

const reqErrorsMap = new Map<number, string>();

let hardstop = false;

interface TPSConfig {
    tpsServerHost: string;
    tpsServerPort: number;
    endpoint: string;
    variant: string;
    deployer: {
        address: string;
        privateKey: string;
    };
    nftReceiver: string;
    timeout: number;
    nftAmount: number;
    txpoolMaxLength: number;
    txpoolLimit: number;
    checkersInterval: number;
}

const setConfig = async (configFilename: string, deployer: KeyringPair) => {
    // @ts-ignore
    let url = network.config.url;
    let config: TPSConfig = {
        tpsServerHost: '0.0.0.0',
        tpsServerPort: 8181,
        endpoint: url || 'http://127.0.0.1:9944',
        variant: 'substrate',
        deployer: {
            address: deployer.address,
            privateKey: deployer.address,
        },
        nftReceiver: '0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0',
        timeout: 5000,
        txpoolMaxLength: -1,
        txpoolLimit: 7500,
        checkersInterval: 250,
        nftAmount: 8000,
    };

    if (fs.existsSync(configFilename)) {
        const fromJSON = await readJSON(configFilename);
        config = { ...config, ...fromJSON };
    }

    await promisify(fs.writeFile)(configFilename, JSON.stringify(config, null, 2));

    return config;
};

class SubstrateApi {
    wsEndpoint: string;
    api: ApiPromise | null;
    constructor(wsEndpoint: string) {
        this.wsEndpoint = wsEndpoint.replace('http://', 'ws://').replace('https://', 'wss://');
        this.api = null;
    }
    async get(config: TPSConfig) {
        if (!this.wsEndpoint)
            this.wsEndpoint = config.endpoint
                .replace('http://', 'ws://')
                .replace('https://', 'wss://');
        if (!this.api)
            this.api = await ApiPromise.create({ provider: new WsProvider(this.wsEndpoint) });
        return this.api;
    }
}
const substrateApi = new SubstrateApi('');

const main = async () => {
    let config = await setup();

    const app = express();
    app.use(BodyParser.json());

    app.get('/auto', async (req: any, res: any) => {
        console.log(`[Server] Running auto()...`);
        const [status, msg] = await auto(config);
        if (status === 0) res.send(msg);
        else res.status(500).send(`Internal error: /auto ${msg}`);
    });

    app.listen(config.tpsServerPort, config.tpsServerHost, () => {
        console.log(`> Listening at http://${config.tpsServerHost}:${config.tpsServerPort}`);
    });
};

const setup = async () => {
    let deployer = await getDeployer(EVM_TPS_CONFIG_FILE);
    let config = await setConfig(EVM_TPS_CONFIG_FILE, deployer);

    await batchMintNfts(config, deployer);

    return config;
};

const batchMintNfts = async (config: TPSConfig, deployer: KeyringPair) => {
    const api = await substrateApi.get(config);
    let nonce = (await api.rpc.system.accountNextIndex(deployer.address)).toNumber();

    //Create collection
    let nftCollectionCreation = (
        await api.tx.nfts.create(deployer.address, {}).signAndSend(deployer, { nonce })
    ).toString();
    if (!validTxHash(nftCollectionCreation))
        throw Error(`[ERROR] batchMintNfts() -> ${JSON.stringify(nftCollectionCreation)}`);

    nonce++;

    // Mint nfts to deployer account
    let txHash;
    for (let k = 0; k < config.nftAmount; k++) {
        txHash = (
            await api.tx.nfts.mint(0, k, deployer.address, null).signAndSend(deployer, { nonce })
        ).toString();
        if (!validTxHash(txHash))
            throw Error(`[ERROR] batchMintNfts() -> ${JSON.stringify(txHash)}`);
        console.log(`[batchMintNfts] Minting Nft ${k} to ${deployer.address} -> ${txHash}`);
        if ((k + 1) % 500 === 0) await new Promise((r) => setTimeout(r, 6000));
        // @ts-ignore
        nonce++;
    }

    console.log('Nft Minting complete');
};

const auto = async (config: TPSConfig) => {
    let status_code = 0;
    let msg = '';
    const start = Date.now();

    try {
        const api = await substrateApi.get(config);
        let startingBlock = await getBlockWithExtras(api, null);
        let nftIdCounter = 0;
        let sender = await getDeployer(EVM_TPS_CONFIG_FILE);
        let nonce = (await api.rpc.system.accountNextIndex(sender.address)).toNumber();

        while (nftIdCounter < config.nftAmount) {
            if (hardstop) {
                hardstop = false;
                return [0, 'HARD_STOP'];
            }
            transferNft(api, nftIdCounter, sender, nonce, config.nftReceiver);
            nonce++;
            nftIdCounter++;
        }
    } catch (error: any) {
        console.log(error);
    }

    return [status_code, msg];
};

const transferNft = async (
    api: ApiPromise,
    itemId: number,
    sender: KeyringPair,
    nonce: number,
    receiver: string
) => {
    const txHash = (
        await api.tx.nfts.transfer(0, itemId, receiver).signAndSend(sender, { nonce })
    ).toString();
    if (!validTxHash(txHash)) throw Error(`[ERROR] submitExtrinsic() -> ${JSON.stringify(txHash)}`);

    return txHash;
};

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});
