import fs from 'fs';
import { promisify } from 'util';

import axios from 'axios';
import express from 'express';
import BodyParser from 'body-parser';

import { ethers, network } from 'hardhat';

import { Wallet } from '@ethersproject/wallet';
import { BigNumber } from 'ethers';
import { PopulatedTransaction } from 'ethers/lib/ethers';

import { deploy } from './common';
import { deployNfts, transferNfts } from './nfts';
import { Block } from '@ethersproject/providers';
import { erc20 } from '../typechain-types/@openzeppelin/contracts/token';

const EVM_TPS_ROOT_DIR = process.env.ROOT_DIR || 'data';
const EVM_TPS_SENDERS_FILE = `${EVM_TPS_ROOT_DIR}/senders.json`;
const EVM_TPS_RECEIVERS_FILE = `${EVM_TPS_ROOT_DIR}/receivers.json`;

let EVM_TPS_CONFIG_FILE = `${EVM_TPS_ROOT_DIR}/config.json`;

interface Balances {
    before: number;
    after: number;
}

// Map from key-id to the private key
const sendersMap = new Map<number, Wallet>();
const receiversMap = new Map<number, Wallet>();
const rcvBalances = new Map<number, Balances>();

const nonceMap = new Map<number, number>();

const receiptsMap = new Map<string, any>();

const workersMap = new Map<number, boolean>();
const sendersBusyMap = new Map<number, boolean>();
const sendersFreeMap = new Map<number, boolean>();
const sendersTxnMap = new Map<number, number>();
const sendersErrMap = new Map<number, number>();

const reqErrorsMap = new Map<number, string>();

let txPoolLength = 0;

// Should be sufficient to send 100k transactions
let gasPrice = ethers.BigNumber.from(1_000_000_000_000);
let chainGasPrice = ethers.BigNumber.from(0);

let reqCounter = 0;
let reqErrCounter = 0;
let nextKey = 0;
let lastTxHash = '';
let hardstop = false;

const zeroPad = (num: number, places: number) => String(num).padStart(places, '0');

interface Funding {
    senders: boolean;
    amount: string;
    mint: number;
}

interface Transaction {
    module: string;
    address: string;
    method: string;
    amountIdx: number;
    params: Array<any>;
    gasLimit: string;
    quantity: number;
}

interface TPSConfig {
    tpsServerHost: string;
    tpsServerPort: number;
    endpoint: string;
    variant: string;
    deployer: {
        address: string;
        privateKey: string;
    };
    accounts: number;
    workers: number;
    funding: Funding;
    txn: Transaction;
    txpoolMaxLength: number;
    txpoolMultiplier: number;
    txpoolLimit: number;
    checkersInterval: number;
    estimate: boolean | undefined;
    timeout: number;
    payloads: UnsignedTx[] | PopulatedTransaction[] | undefined;
    verbose: boolean;
    automaticTrigger: boolean;
}

interface UnsignedTx {
    from: string;
    to: string;
    value?: BigNumber | string;
    data: string;
    gasPrice?: BigNumber | string;
    gasLimit?: BigNumber | string;
    nonce?: number;
    chainId?: number;
}

const readJSON = async (filename: string) => {
    const j = await promisify(fs.readFile)(filename);
    return JSON.parse(j.toString());
};

const getDeployer = async (configFilename: string) => {
    try {
        const config = await readJSON(configFilename);
        return new ethers.Wallet(config.deployer.privateKey, ethers.provider);
    } catch (_) {
        return ethers.Wallet.createRandom().connect(ethers.provider);
    }
};

const setConfig = async (configFilename: string, deployer: Wallet) => {
    // @ts-ignore
    let url = network.config.url;
    let config: TPSConfig = {
        tpsServerHost: '0.0.0.0',
        tpsServerPort: 8181,
        endpoint: url || 'http://127.0.0.1:9944',
        variant: 'substrate',
        deployer: {
            address: deployer.address,
            privateKey: deployer.privateKey,
        },
        accounts: 100,
        workers: 80,
        funding: {
            senders: true,
            amount: '1000000000000000000000',
            mint: 1_000_000_000,
        },
        txn: {
            module: 'erc20',
            address: '',
            method: 'transferLoop',
            amountIdx: 2,
            // (n, to, amount)
            params: [1, '<ACCOUNT>', 1],
            gasLimit: '200000',
            quantity: 5000,
        },
        txpoolMaxLength: -1,
        txpoolMultiplier: 2,
        txpoolLimit: 7500,
        checkersInterval: 250,
        estimate: false,
        timeout: 5000,
        payloads: undefined,
        verbose: false,
        automaticTrigger: true,
    };

    if (fs.existsSync(configFilename)) {
        const fromJSON = await readJSON(configFilename);
        config = { ...config, ...fromJSON };
    }

    const gasLimit = ethers.BigNumber.from(config.txn.gasLimit);

    chainGasPrice = await ethers.provider.getGasPrice();
    if (chainGasPrice.mul(2).gt(gasPrice)) gasPrice = chainGasPrice.mul(2);

    if (config.txn.module == 'erc20') {
        let tokenAddress = config.txn.address || '';
        if (tokenAddress === '' && config.payloads?.length)
            tokenAddress = config.payloads[0].to ? config.payloads[0].to : tokenAddress;

        if (tokenAddress !== '') {
            const bytecode = await ethers.provider.getCode(tokenAddress);
            if (bytecode.length <= 2) tokenAddress = ''; // 0x
        }

        if (tokenAddress === '' && config.payloads === undefined) {
            const token = await deploy(deployer);
            let tx = await token.start({ gasLimit, gasPrice });
            await tx.wait();
            tx = await token.mintTo(deployer.address, config.funding.mint);
            await tx.wait();
            config.txn.address = token.address;
        }
    }

    await promisify(fs.writeFile)(configFilename, JSON.stringify(config, null, 2));

    return config;
};

const setTxpool = async (config: TPSConfig, deployer: Wallet) => {
    let lastBlock = await ethers.provider.getBlock('latest');

    const chainGasPrice = await ethers.provider.getGasPrice();
    const gasLimit = ethers.BigNumber.from(config.txn.gasLimit);

    let estimateGasTx;
    if (config.payloads?.length)
        estimateGasTx = await ethers.provider.estimateGas(config.payloads[0]);
    else {
        const receiver = receiversMap.get(0)!;
        const token = (await ethers.getContractFactory('SimpleToken', deployer)).attach(
            config.txn.address
        );
        const params = config.txn.params.map((p) => (p == '<ACCOUNT>' ? receiver.address : p));
        // @ts-ignore
        estimateGasTx = await token.estimateGas[config.txn.method](...params, {
            gasPrice: chainGasPrice.mul(2),
            gasLimit: lastBlock.gasLimit.mul(2).div(3),
        });
    }

    if (estimateGasTx.gt(gasLimit)) {
        console.log(
            `\n[  Gas ] estimateGas > config.gasLimit | ${estimateGasTx} > ${config.txn.gasLimit}`
        );
        console.log(`[  Gas ] Updating config.gasLimit: ${estimateGasTx}`);
        config.txn.gasLimit = estimateGasTx.toString();
    }

    // We pre calculate the max txn per block we can get and set the txpool max size to * txpoolMultiplier of it.
    console.log(`\n[Txpool] Trying to get a proper Txpool max length...`);
    console.log(`[Txpool] Block gasLimit   : ${lastBlock.gasLimit}`);
    console.log(`[Txpool] Txn estimateGas  : ${estimateGasTx}`);
    let max_txn_block = lastBlock.gasLimit.div(estimateGasTx).toNumber();
    console.log(`[Txpool] Max txn per Block: ${max_txn_block}`);

    if (config.txpoolMaxLength === -1) {
        let maxTxnMultiplier = max_txn_block * config.txpoolMultiplier;
        if (maxTxnMultiplier > 5000)
            config.txpoolMaxLength = Math.round(maxTxnMultiplier / 1000) * 1000;
        else config.txpoolMaxLength = maxTxnMultiplier;
    }

    console.log(`[Txpool] Max length       : ${config.txpoolMaxLength}`);
    if (config.txpoolMaxLength > config.txpoolLimit) {
        config.txpoolMaxLength = config.txpoolLimit;
        console.log(`[Txpool] Using pool limit : ${config.txpoolMaxLength} ***`);
    }

    return config;
};

const setupAccounts = async (
    config: TPSConfig,
    sendersFilename: string,
    receiversFilename: string
) => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const staticProvider = new ethers.providers.StaticJsonRpcProvider(config.endpoint, {
        name: 'tps',
        chainId,
    });

    let account: Wallet | null = null;
    try {
        let keysByIds = await readJSON(sendersFilename);
        console.log(
            `[setupAccounts] Reading ${Object.keys(keysByIds).length} senders' accounts...`
        );
        for (let k of Object.keys(keysByIds)) {
            account = new ethers.Wallet(keysByIds[k].privateKey, staticProvider);
            sendersMap.set(parseInt(k), account);
        }

        keysByIds = await readJSON(receiversFilename);
        console.log(
            `[setupAccounts] Reading ${Object.keys(keysByIds).length} receivers' accounts...`
        );
        for (let k of Object.keys(keysByIds)) {
            account = new ethers.Wallet(keysByIds[k].privateKey, staticProvider);
            receiversMap.set(parseInt(k), account);
        }

        return;
    } catch (error: any) {}

    let senders: any = {};
    let receivers: any = {};
    console.log(
        `[setupAccounts] Creating ${config.accounts} senders and ${config.accounts} receivers accounts...`
    );
    for (let k = 0; k < config.accounts; k++) {
        account = ethers.Wallet.createRandom().connect(staticProvider);
        sendersMap.set(k, account);
        senders[k] = { address: account.address, privateKey: account.privateKey };

        account = ethers.Wallet.createRandom().connect(staticProvider);
        receiversMap.set(k, account);
        receivers[k] = { address: account.address, privateKey: account.privateKey };
    }

    await promisify(fs.writeFile)(sendersFilename, JSON.stringify(senders, null, 2));
    await promisify(fs.writeFile)(receiversFilename, JSON.stringify(receivers, null, 2));
};

const post = async (config: TPSConfig, method: string, params: any[]) => {
    let r = await axios.post(
        config.endpoint,
        {
            jsonrpc: '2.0',
            method,
            params,
            id: 1,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: config.timeout }
    );
    return r.data;
};

const waitForResponse = async (
    config: TPSConfig,
    method: string,
    params: any[],
    delay: number,
    retries: number
) => {
    let result;
    for (let counter = 0; counter < retries; counter++) {
        try {
            let r = await post(config, method, params);
            result = r.result;
            if (result) break;
        } catch (err: any) {
            console.log(`ERROR: waitForResponse() -> ${err}`);
        }
        counter++;
        if (counter >= retries) break;
        await new Promise((r) => setTimeout(r, delay));
    }
    return result;
};

const batchMintTokens = async (config: TPSConfig, deployer: Wallet) => {
    const token = (await ethers.getContractFactory('SimpleToken', deployer)).attach(
        config.txn.address
    );

    const gasLimit = ethers.BigNumber.from('1000000');
    const chainId = await deployer.getChainId();

    let nonce = await deployer.getTransactionCount();

    let txHash;
    for (let k = 0; k < sendersMap.size; k++) {
        const sender = sendersMap.get(k)!;
        let unsigned = await token.populateTransaction.mintTo(sender.address, config.txn.address);
        unsigned = {
            ...unsigned,
            gasLimit,
            gasPrice,
            nonce,
            chainId,
        };
        nonce++;
        let payload = await deployer.signTransaction(unsigned);
        let data = await post(config, 'eth_sendRawTransaction', [payload]);

        let txHash = data.result;
        if (!validTxHash(txHash))
            throw Error(`[ERROR] batchMintTokens() -> ${JSON.stringify(data)}`);
        console.log(`[batchMintTokens] Minting tokens to ${sender.address} -> ${txHash}`);
        if ((k + 1) % 500 === 0) await new Promise((r) => setTimeout(r, 6000));
    }
    await getReceiptLocally(txHash!, 500, 60);
    return nonce;
};

const batchSendEthers = async (config: TPSConfig, deployer: Wallet, nonce: number | null) => {
    const gasLimit = ethers.BigNumber.from('1000000');
    const chainId = await deployer.getChainId();

    if (!nonce) nonce = await deployer.getTransactionCount('pending');

    let txHash;
    for (let k = 0; k < sendersMap.size; k++) {
        const sender = sendersMap.get(k)!;
        let unsigned = {
            from: deployer.address,
            to: sender.address,
            value: ethers.utils.parseEther('1000'),
            gasLimit,
            gasPrice,
            nonce,
            chainId,
        };
        nonce++;
        let payload = await deployer.signTransaction(unsigned);
        let data = await post(config, 'eth_sendRawTransaction', [payload]);
        let txHash = data.result;
        if (!validTxHash(txHash))
            throw Error(`[ERROR] batchSendEthers() -> ${JSON.stringify(data)}`);
        console.log(`[batchSendEthers] Sending ETH to ${sender.address} -> ${txHash}`);
        if ((k + 1) % 500 === 0) await new Promise((r) => setTimeout(r, 6000));
    }
    await getReceiptLocally(txHash!, 500, 60);
    return nonce;
};

const sendRawTransaction = async (
    config: TPSConfig,
    k: number,
    nonce: number,
    gasLimit: BigNumber,
    chainId: number
) => {
    const sender = sendersMap.get(k)!;
    const receiver = receiversMap.get(k)!;

    const token = (await ethers.getContractFactory('SimpleToken', sender)).attach(
        config.txn.address
    );

    const params = config.txn.params.map((p) => (p == '<ACCOUNT>' ? receiver.address : p));

    // @ts-ignore
    let unsigned = await token.populateTransaction[config.txn.method](...params);
    unsigned = {
        ...unsigned,
        gasLimit,
        gasPrice,
        nonce,
        chainId,
    };
    let payload = await sender.signTransaction(unsigned);
    let data = await post(config, 'eth_sendRawTransaction', [payload]);
    let txHash = data.result;
    if (!validTxHash(txHash))
        throw Error(`[ERROR] sendRawTransaction() -> ${JSON.stringify(data)}`);
    return txHash;
};

const blockTracker = async (config: TPSConfig) => {
    let blockNumber = 0;
    while (1) {
        if (receiptsMap.size > 10_000) receiptsMap.clear();

        try {
            let block = await waitForResponse(
                config,
                'eth_getBlockByNumber',
                ['latest', false],
                250,
                1
            );
            if (block.number != blockNumber) {
                let receipts;
                if (config.variant === 'parity') {
                    receipts = await waitForResponse(
                        config,
                        'parity_getBlockReceipts',
                        [block.number],
                        250,
                        1
                    );
                } else {
                    receipts = [];
                    for (let txnHash of block.transactions) {
                        receipts.push(
                            await waitForResponse(
                                config,
                                'eth_getTransactionReceipt',
                                [txnHash],
                                250,
                                1
                            )
                        );
                    }
                }
                if (receipts === undefined)
                    throw Error(
                        `Not able to fetch receipts using parity_getBlockReceipts for ${block.number}!`
                    );
                for (let r of receipts) {
                    // Storing just (hash, status) to save memory.
                    receiptsMap.set(r.transactionHash, r.status);
                }
                const ratio = Math.round((block.gasUsed / block.gasLimit) * 100);
                let msg = `[BlockTracker] Block: ${zeroPad(parseInt(block.number, 16), 4)} | `;
                msg += `txns: ${zeroPad(receipts.length, 4)} | `;
                msg += `gasUsed: ${zeroPad(parseInt(block.gasUsed, 16), 9)} (~${zeroPad(
                    ratio,
                    3
                )}%) `;
                msg += `[gasPrice: ${printGasPrice(chainGasPrice)} | pool: ${zeroPad(
                    txPoolLength,
                    5
                )}]`;
                if (lastTxHash && !config.verbose) msg += ` -> txHash: ${lastTxHash} `;
                console.log(msg);
            }
            blockNumber = block.number;
        } catch {}
        await new Promise((r) => setTimeout(r, config.checkersInterval));
    }
};

const getReceiptLocally = async (txnHash: string, delay: number, retries: number) => {
    let receipt;
    for (let counter = 0; counter < retries; counter++) {
        try {
            receipt = receiptsMap.get(txnHash);
            if (receipt !== undefined) break;
        } catch {}
        counter++;
        if (counter >= retries) break;
        await new Promise((r) => setTimeout(r, delay));
    }
    return receipt;
};

const txpoolChecker = async (config: TPSConfig) => {
    let method = 'author_pendingExtrinsics';
    if (['geth'].includes(config.variant)) method = 'txpool_status';
    else if (config.variant === 'parity') method = 'parity_pendingTransactions';

    while (1) {
        try {
            let result = await waitForResponse(config, method, [], 250, 1);
            if (['geth'].includes(config.variant)) {
                txPoolLength = parseInt(result.pending, 16) + parseInt(result.queued, 16);
            } else txPoolLength = result.length;
        } catch {
            txPoolLength = -1;
        }
        await new Promise((r) => setTimeout(r, config.checkersInterval));
    }
};

const gasPriceChecker = async (config: TPSConfig) => {
    while (1) {
        try {
            let result = await waitForResponse(config, 'eth_gasPrice', [], 250, 1);
            chainGasPrice = ethers.BigNumber.from(result);
            if (chainGasPrice.mul(2).gte(gasPrice)) gasPrice = chainGasPrice.mul(2);
        } catch {}
        await new Promise((r) => setTimeout(r, config.checkersInterval));
    }
};

const printGasPrice = (value: BigNumber) => {
    let normalized = `${Math.round(value.div(1_000_000).toNumber())}M`;
    if (value.gte(1_000_000_000))
        normalized = `${Math.round(value.div(1_000_000_000).toNumber())}B`;
    if (value.gte(1_000_000_000_000))
        normalized = `${Math.round(value.div(1_000_000_000_000).toNumber())}T`;
    if (value.gte(1_000_000_000_000_000))
        normalized = `${Math.round(value.div(1_000_000_000_000_000).toNumber())}Q`;
    return normalized;
};

const checkTxpool = async (config: TPSConfig) => {
    if (config.txpoolMaxLength > 0) {
        while (txPoolLength === -1 || txPoolLength >= config.txpoolMaxLength) {
            await new Promise((r) => setTimeout(r, 5));
        }
    }
};

const checkTokenBalances = async (config: TPSConfig, deployer: Wallet) => {
    const token = (await ethers.getContractFactory('SimpleToken', deployer)).attach(
        config.txn.address
    );
    const sender = sendersMap.get(0)!;
    const balance = await token.balanceOf(sender.address);
    console.log(`[checkTokenBalances] ${sender.address} token balance: ${balance}`);
    if (balance.isZero()) return await batchMintTokens(config, deployer);
};

const checkETHBalances = async (config: TPSConfig, deployer: Wallet, nonce: number | null) => {
    const sender = sendersMap.get(0)!;
    const balance = await sender.getBalance();
    console.log(`[checkETHBalances] ${sender.address} ETH balance: ${balance}`);
    if (balance.lte(ethers.utils.parseEther('750'))) await batchSendEthers(config, deployer, nonce);
};

const assertTokenBalances = async (config: TPSConfig) => {
    let diffs = 0;
    const receiver = receiversMap.get(0)!;
    const token = (await ethers.getContractFactory('SimpleToken', receiver)).attach(
        config.txn.address
    );
    for (let k = 0; k < config.accounts; k++) {
        const amounts = rcvBalances.get(k)!;
        const receiver = receiversMap.get(k)!;
        const amount = await token.balanceOf(receiver.address);
        const ok = amounts.after === amount.toNumber();
        if (!ok) diffs++;
    }
    if (diffs > 0)
        console.log(
            `[assertTokenBalances][ERROR] Balance is different for ${diffs} receivers. ***`
        );
    else console.log(`[assertTokenBalances] OK`);
};

const updateNonces = async (config: TPSConfig) => {
    for (let k = 0; k < config.accounts; k++) {
        const sender = sendersMap.get(k)!;
        const nonce = await sender.getTransactionCount();
        console.log(`[updateNonces] ${sender.address} -> ${nonce}`);
        nonceMap.set(k, nonce);
    }
};

const updateBalances = async (config: TPSConfig) => {
    const receiver = receiversMap.get(0)!;
    const token = (await ethers.getContractFactory('SimpleToken', receiver)).attach(
        config.txn.address
    );
    for (let k = 0; k < config.accounts; k++) {
        const receiver = receiversMap.get(k)!;
        const amount = await token.balanceOf(receiver.address);
        console.log(`[updateBalances] ${receiver.address} -> ${amount}`);
        rcvBalances.set(k, { before: amount.toNumber(), after: amount.toNumber() });
    }
};

const resetMaps = (config: TPSConfig) => {
    sendersMap.clear();
    sendersBusyMap.clear();
    sendersFreeMap.clear();
    sendersTxnMap.clear();
    receiversMap.clear();
    rcvBalances.clear();
    receiptsMap.clear();
    nonceMap.clear();
    workersMap.clear();
    sendersErrMap.clear();
    reqErrorsMap.clear();
    initNumberMap(sendersErrMap, config.accounts, 0);
    initNumberMap(sendersTxnMap, config.accounts, 0);
    initNumberMap(sendersFreeMap, config.accounts, true);
    lastTxHash = '';
};

const setupDirs = () => {
    try {
        fs.mkdirSync(EVM_TPS_ROOT_DIR);
    } catch (error: any) {
        if (error.code !== 'EEXIST') {
            console.error(
                `[ERROR] Failed to create directories [${EVM_TPS_ROOT_DIR}]: ${error.message}`
            );
            process.exit(1);
        }
    }
};

const calculateTPS = async (config: TPSConfig, chainId: number, startingBlock: Block) => {
    let lastBlock = await waitForResponse(
        config,
        'eth_getBlockByNumber',
        ['latest', false],
        250,
        500
    );

    let lastBlockNumber = lastBlock.number;
    while (lastBlock.transactions.length > 0 || lastBlock.number === startingBlock.number) {
        lastBlockNumber = lastBlock.number;
        await new Promise((r) => setTimeout(r, 200));
        lastBlock = await waitForResponse(
            config,
            'eth_getBlockByNumber',
            ['latest', false],
            250,
            500
        );
    }

    lastBlock = await waitForResponse(
        config,
        'eth_getBlockByNumber',
        [lastBlockNumber, false],
        250,
        500
    );

    let t = lastBlock.timestamp - startingBlock.timestamp;
    let err = `[errors=${reqErrorsMap.size}]`;
    let blocks = lastBlock.number - startingBlock.number;
    return `blocks=${blocks} (${startingBlock.number} -> ${parseInt(
        lastBlock.number,
        16
    )}) | txns=${config.txn.quantity} t=${t} -> ${config.txn.quantity / t} TPS/RPS ${err}`;
};

const initNumberMap = (m: Map<number, any>, length: number, value: any) => {
    for (let i = 0; i < length; i++) m.set(i, value);
};

const printNumberMap = (m: Map<number, any>) => {
    let msg = '\n\n';
    for (let i = 0; i < m.size; i++) msg += `\n[printMap][${zeroPad(i, 5)}] ${m.get(i)!}`;
    msg += '\n\n';
    return msg;
};

const getAvailSender = async (config: TPSConfig, key: number) => {
    const maxTxnPerSender = Math.ceil(config.txn.quantity / config.accounts);
    key = key === 0 ? key : key + 1;
    if (key >= config.accounts) key = 0;
    while (sendersFreeMap.size > 0) {
        let availKeys = sendersFreeMap.keys();
        for (let k of availKeys) {
            if (sendersTxnMap.get(k)! >= maxTxnPerSender) {
                sendersFreeMap.delete(k);
                continue;
            }
            if (k < key) continue;
            if (sendersBusyMap.get(k)!) continue;
            return k;
        }
        key++;
        if (key >= config.accounts) key = 0;
        await new Promise((r) => setTimeout(r, 1));
    }
    return -1;
};

const getFreeWorker = async (config: TPSConfig, workerId: number) => {
    workerId = workerId === 0 ? workerId : workerId + 1;
    if (workerId >= config.workers) workerId = 0;
    while (workersMap.get(workerId)!) {
        await new Promise((r) => setTimeout(r, 1));
        workerId++;
        if (workerId >= config.workers) workerId = 0;
    }
    return workerId;
};

const validTxHash = (txHash: string | undefined) => {
    if (txHash === undefined || txHash === null) return false;
    if (!txHash?.startsWith('0x')) return false;
    if (txHash?.length !== 66) return false;
    return true;
};

const resendAuto = async (
    config: TPSConfig,
    workerId: number,
    gasLimit: BigNumber,
    chainId: number
) => {
    const sendersErrMapCopy = new Map(sendersErrMap);
    sendersErrMap.clear();

    console.log(`\n\n----- Resending ${reqErrorsMap.size} Failed Requests -----\n\n`);
    console.log(printNumberMap(reqErrorsMap));

    reqCounter -= reqErrorsMap.size;
    reqErrorsMap.clear();
    reqErrCounter = 0;

    for (let k = 0; k < sendersErrMapCopy.size; k++) {
        let nonce = nonceMap.get(k)!;
        for (let j = 0; j < sendersErrMapCopy.get(k)!; j++) {
            await checkTxpool(config);
            workerId = await getFreeWorker(config, workerId);
            reqCounter++;
            autoSendRawTransaction(config, workerId, k, nonce, gasLimit, chainId);
            nonce++;
        }
        nonceMap.set(k, nonce);
    }
};

const autoSendRawTransaction = async (
    config: TPSConfig,
    workerId: number,
    senderKey: number,
    nonce: number,
    gasLimit: BigNumber,
    chainId: number
) => {
    sendersBusyMap.set(senderKey, true);
    workersMap.set(workerId, true);

    const pre = `[req: ${zeroPad(reqCounter, 5)}][addr: ${zeroPad(senderKey, 5)}]`;
    let post = `[wrk: ${zeroPad(workerId, 5)}(len=${zeroPad(workersMap.size, 5)}) `;
    post += `nonce: ${zeroPad(nonce, 5)} | `;
    post += `gasPrice: ${printGasPrice(gasPrice)} / ${printGasPrice(chainGasPrice)} | `;
    post += `pool: ${zeroPad(txPoolLength, 5)} | err=${reqErrorsMap.size}]`;
    let msg = '';

    const start = Date.now();
    try {
        const txHash = await sendRawTransaction(config, senderKey, nonce, gasLimit, chainId);
        if (validTxHash(txHash)) {
            const t = Date.now() - start;
            const postWithTime = `${post} [time: ${zeroPad(t, 5)}${t > 12000 ? ' ***' : ''}]`;
            msg = `${pre} auto: ${txHash} ${postWithTime}`;
            if (config.verbose) console.log(msg);

            lastTxHash = txHash;
            let nextNonce = nonce + 1;
            nonceMap.set(senderKey, nextNonce);

            let amounts = rcvBalances.get(senderKey)!;
            amounts.after += config.txn.params[config.txn.amountIdx];
            rcvBalances.set(senderKey, amounts);
        } else {
            throw Error(`Invalid txHash: ${txHash}`);
        }
    } catch (error: any) {
        sendersErrMap.set(senderKey, sendersErrMap.get(senderKey)! + 1);
        sendersTxnMap.set(senderKey, sendersTxnMap.get(senderKey)! - 1);
        sendersFreeMap.set(senderKey, true);
        msg = `${pre} auto: ${error.message} ${post}`;
        reqErrorsMap.set(reqErrCounter, msg);
        reqErrCounter++;
    }

    sendersBusyMap.delete(senderKey);
    workersMap.delete(workerId);
};

const auto = async (config: TPSConfig, gasLimit: BigNumber, chainId: number) => {
    const staticProvider = new ethers.providers.StaticJsonRpcProvider(config.endpoint, {
        name: 'tps',
        chainId,
    });

    let status_code = 0;
    let msg = '';
    const start = Date.now();
    let workerId = 0;
    try {
        let startingBlock = await staticProvider.getBlock('latest');
        let initialCounter = reqCounter;

        if (config.txn.module === 'erc20') {
            while (reqCounter - initialCounter < config.txn.quantity) {
                if (hardstop) {
                    hardstop = false;
                    return [0, 'HARD_STOP'];
                }
                // 5% of errors is too much, something is wrong.
                if (reqErrorsMap.size >= config.txn.quantity * 0.05) {
                    console.log(printNumberMap(reqErrorsMap));
                    let p = Math.round((reqErrorsMap.size / config.txn.quantity) * 100);
                    return [
                        0,
                        `TOO_MANY_ERRORS: ${reqErrorsMap.size}/${config.txn.quantity} [~${p}%]`,
                    ];
                }
                await checkTxpool(config);
                nextKey = await getAvailSender(config, nextKey);
                if (nextKey === -1 || sendersFreeMap.size === 0) break;
                workerId = await getFreeWorker(config, workerId);
                const nonce = nonceMap.get(nextKey)!;
                reqCounter++;
                autoSendRawTransaction(config, workerId, nextKey, nonce, gasLimit, chainId);
                sendersTxnMap.set(nextKey, sendersTxnMap.get(nextKey)! + 1);
            }
        }

        if (config.txn.module === 'erc721') {
            transferNfts(nftAddress, config.txn.quantity);
        }

        // Wait till no more running workers.
        while (workersMap.size > 0) {
            await new Promise((r) => setTimeout(r, 5));
        }

        while (reqErrorsMap.size > 0) await resendAuto(config, workerId, gasLimit, chainId);

        while (txPoolLength > 0) await new Promise((r) => setTimeout(r, 100));

        // Wait till no more running workers.
        while (workersMap.size > 0) {
            await new Promise((r) => setTimeout(r, 5));
        }

        let tpsResult = await calculateTPS(config, chainId, startingBlock);
        reqErrorsMap.clear();
        reqErrCounter = 0;

        if (config.txn.module === 'erc20') {
            await assertTokenBalances(config);
        }

        lastTxHash = '';

        let t = Date.now() - start;
        let pre = `[req: ${zeroPad(reqCounter, 5)}][addr: ${zeroPad(0, 5)}]`;
        let post = `[wrk: ${zeroPad(workersMap.size, 5)} | pool: ${zeroPad(
            txPoolLength,
            5
        )} | time: ${zeroPad(t, 5)}]`;
        msg = `${pre} auto: ${tpsResult} ${post}`;
    } catch (error: any) {
        msg = `[ERROR][req: ${zeroPad(reqCounter, 5)}][wrk: ${zeroPad(workersMap.size, 5)}] auto: ${
            error.message
        }`;
    }
    console.log(msg);
    return [status_code, msg];
};

let nftAddress = '';
const setup = async () => {
    setupDirs();

    let deployer = await getDeployer(EVM_TPS_CONFIG_FILE);
    let config = await setConfig(EVM_TPS_CONFIG_FILE, deployer);

    resetMaps(config);

    if (config.txn.module === 'erc20') {
        await setupAccounts(config, EVM_TPS_SENDERS_FILE, EVM_TPS_RECEIVERS_FILE);
        let deployerNonce = await checkTokenBalances(config, deployer);
        if (config.funding.senders) await checkETHBalances(config, deployer, deployerNonce!);

        await updateNonces(config);
        await updateBalances(config);
        config = await setTxpool(config, deployer);
    }

    if (config.txn.module === 'erc721' && nftAddress == '') {
        nftAddress = await deployNfts(config.txn.quantity);
    }

    console.log(JSON.stringify(config, null, 2));

    hardstop = false;

    return config!;
};

const main = async () => {
    let config = await setup();

    blockTracker(config);
    txpoolChecker(config);

    const gasLimit = ethers.BigNumber.from(config.txn.gasLimit);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    gasPriceChecker(config);

    const app = express();
    app.use(BodyParser.json());

    if (config.automaticTrigger) {
        config = await setup();
        console.log(`[Server] Running auto()...`);
        const [status, msg] = await auto(config, gasLimit, chainId);

        console.log(`[Server] ${msg}`);
    } else {
        app.get('/auto', async (req: any, res: any) => {
            config = await setup();
            console.log(`[Server] Running auto()...`);
            const [status, msg] = await auto(config, gasLimit, chainId);
            if (status === 0) res.send(msg);
            else res.status(500).send(`Internal error: /auto ${msg}`);
        });
    }

    app.get('/sendRawTransaction', async (req: any, res: any) => {
        await checkTxpool(config);

        nextKey = await getAvailSender(config, nextKey);

        const nonce = nonceMap.get(nextKey)!;
        let nextNonce = nonce + 1;
        nonceMap.set(nextKey, nextNonce);

        const start = Date.now();
        try {
            const txHash = await sendRawTransaction(config, nextKey, nonce, gasLimit, chainId);
            const t = Date.now() - start;
            const pre = `[req: ${zeroPad(reqCounter, 5)}][addr: ${zeroPad(nextKey, 5)}]`;
            const post = `[nonce: ${nonce} | pool: ${txPoolLength} | time: ${t}]${
                t > 12000 ? ' ***' : ''
            }`;
            const msg = `${pre} sendRawTransaction: ${txHash} ${post}`;
            reqCounter++;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            console.error(
                `[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(
                    nextKey,
                    5
                )}] sendRawTransaction: ${error.message}`
            );
            res.status(500).send(`Internal error: /sendRawTransaction ${error.message}`);
        }
    });

    app.get('/getBlock', async (req: any, res: any) => {
        nextKey = await getAvailSender(config, nextKey);
        try {
            const start = Date.now();
            const sender = sendersMap.get(nextKey)!;
            let b = await sender.provider.getBlock('latest');
            const t = Date.now() - start;
            const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(
                nextKey,
                5
            )}] getBlock: [b: ${b.number} | t: ${t}]${t > 12000 ? ' ***' : ''}`;
            reqCounter++;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            console.error(
                `[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(nextKey, 5)}] getBlock: ${
                    error.message
                }`
            );
            res.status(500).send(`Internal error: /getBlock ${error.message}`);
        }
    });

    app.get('/stats', async (req: any, res: any) => {
        try {
            const stats = {
                senders: sendersMap.size,
                receivers: receiversMap.size,
                receipts: receiptsMap.size,
                nonces: nonceMap.size,
                workers: workersMap.size,
                reqCounter,
                errors: reqErrorsMap.size,
            };
            const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(
                -1,
                5
            )}] status: \n${JSON.stringify(stats, null, 2)}\n`;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            console.error(
                `[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] reset: ${
                    error.message
                }`
            );
            res.status(500).send(`Internal error: /stats ${error.message}`);
        }
    });

    app.get('/reset', async (req: any, res: any) => {
        try {
            const start = Date.now();
            config = await setup();
            const t = Date.now() - start;
            const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(
                -1,
                5
            )}] reset: [b: - | t: ${t}]`;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            console.error(
                `[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] reset: ${
                    error.message
                }`
            );
            res.status(500).send(`Internal error: /reset ${error.message}`);
        }
    });

    app.get('/dumpErrors', async (req: any, res: any) => {
        try {
            const msg = `----- dumpErrors: ${printNumberMap(reqErrorsMap)}`;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            res.status(500).send(`Internal error: /dumpErrors ${error.message}`);
        }
    });

    app.get('/stop', async (req: any, res: any) => {
        try {
            const start = Date.now();
            hardstop = true;
            const t = Date.now() - start;
            const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(
                -1,
                5
            )}] stop: [b: - | t: ${t}]`;
            console.log(msg);
            res.send(msg);
        } catch (error: any) {
            res.status(500).send(`Internal error: /stop ${error.message}`);
        }
    });

    app.listen(config.tpsServerPort, config.tpsServerHost, () => {
        console.log(`> Listening at http://${config.tpsServerHost}:${config.tpsServerPort}`);
    });
};

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});
