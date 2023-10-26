import Keyring from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';
import { ethers } from 'hardhat';
import { promisify } from 'util';
import fs from 'fs';
import { ApiPromise } from '@polkadot/api';
import { zeroPad } from 'ethers/lib/utils';

export const getDeployer = async (configFilename: string) => {
    await cryptoWaitReady();
    let keyring = new Keyring({ type: 'sr25519' });
    try {
        const config = await readJSON(configFilename);
        if (config.variant === 'frontier') keyring = new Keyring({ type: 'ethereum' });
        return keyring.createFromUri(config.deployer.privateKey);
    } catch (_) {
        return keyring.createFromUri(ethers.Wallet.createRandom().privateKey);
    }
};

export const readJSON = async (filename: string) => {
    const j = await promisify(fs.readFile)(filename);
    return JSON.parse(j.toString());
};

export const validTxHash = (txHash: string | undefined) => {
    if (txHash === undefined || txHash === null) return false;
    if (!txHash?.startsWith('0x')) return false;
    if (txHash?.length !== 66) return false;
    return true;
};

interface SimpleBlock {
    hash: string;
    number: number;
    timestamp: number;
    extrinsics: string[];
}

export const getBlockWithExtras = async (
    api: ApiPromise,
    number: number | null
): Promise<SimpleBlock> => {
    let hash, block, timestamp;
    if (number) {
        hash = await api.rpc.chain.getBlockHash(number)!;
        block = (await api.rpc.chain.getBlock(hash)!).block;
        timestamp = await (await api.at(hash)).query.timestamp.now();
    } else {
        block = (await api.rpc.chain.getBlock()!).block;
        timestamp = await api.query.timestamp.now();
        hash = block.hash.toHuman();
    }
    return {
        hash,
        number: block.header.number.toNumber(),
        timestamp: parseInt(timestamp.toString()) / 1_000,
        extrinsics: block.extrinsics.map((xt) => blake2AsHex(xt.toHex())),
    };
};

export const printNumberMap = (m: Map<number, any>) => {
    let msg = '\n\n';
    for (let i = 0; i < m.size; i++) msg += `\n[printMap][${zeroPad(i, 5)}] ${m.get(i)!}`;
    msg += '\n\n';
    return msg;
};
