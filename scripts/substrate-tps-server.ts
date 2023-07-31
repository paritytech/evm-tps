import fs from "fs";
import { promisify } from "util";

import axios from "axios";
import express from "express";
import BodyParser from "body-parser";

import { ethers, network } from "hardhat";

import { BigNumber } from "ethers";
import { PopulatedTransaction } from "ethers/lib/ethers";

import { ApiPromise, WsProvider } from '@polkadot/api';
import { KeyringPair } from "@polkadot/keyring/types";
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';

import { BN } from 'bn.js';

const EVM_TPS_ROOT_DIR = process.env.ROOT_DIR || "data";
const EVM_TPS_CONFIG_FILE = `${EVM_TPS_ROOT_DIR}/config.json`;
const EVM_TPS_SENDERS_FILE = `${EVM_TPS_ROOT_DIR}/senders.json`;
const EVM_TPS_RECEIVERS_FILE = `${EVM_TPS_ROOT_DIR}/receivers.json`;

interface SimpleBlock {
  hash: string,
  number: number,
  timestamp: number,
  extrinsics: string[],
}

interface Balances {
  before: number,
  after: number,
}

// Map from key-id to the private key
const sendersMap = new Map<number, KeyringPair>();
const receiversMap = new Map<number, KeyringPair>();
const rcvBalances = new Map<number, Balances>();

const nonceMap = new Map<number, number>();

const receiptsMap = new Map<string, any>();

const workersMap = new Map<number, boolean>();
const workersAPIMap = new Map<number, ApiPromise>();
const sendersBusyMap = new Map<number, boolean>();
const sendersFreeMap = new Map<number, boolean>();
const sendersTxnMap = new Map<number, number>();
const sendersErrMap = new Map<number, number>();

const reqErrorsMap = new Map<number, string>();

let txPoolLength = 0;

let chainFee = ethers.BigNumber.from(0);

let reqCounter = 0;
let reqErrCounter = 0;
let nextKey = 0;
let lastTxHash = "";
let hardstop = false;
let inherentExtrinsics = 0;

class SubstrateApi {
  wsEndpoint: string;
  api: ApiPromise | null;
  constructor(wsEndpoint: string) {
    this.wsEndpoint = wsEndpoint.replace('http://', 'ws://').replace('https://', 'wss://');
    this.api = null;
  }
  async get(config: TPSConfig) {
    if (!this.wsEndpoint) this.wsEndpoint = config.endpoint.replace('http://', 'ws://').replace('https://', 'wss://');
    if (!this.api) this.api = await ApiPromise.create({ provider: new WsProvider(this.wsEndpoint) })
    return this.api;
  }
}

const substrateApi = new SubstrateApi('');

const zeroPad = (num: number, places: number) => String(num).padStart(places, '0')

interface TPSConfig {
  tpsServerHost: string,
  tpsServerPort: number,
  endpoint: string;
  variant: string;
  deployer: {
    address: string,
    privateKey: string,
  },
  fundSenders: boolean,
  accounts: number,
  workers: number,
  sendRawTransaction: boolean;
  timeout: number,
  tokenAddress: string;
  tokenMethod: string;
  tokenAmountToMint: number;
  tokenTransferMultiplier: number;
  tokenAssert: boolean | undefined;
  transactions: number,
  gasLimit: string;
  txpoolMaxLength: number;
  txpoolMultiplier: number;
  txpoolLimit: number;
  checkersInterval: number;
  estimate: boolean | undefined;
  payloads: UnsignedTx[] | PopulatedTransaction[] | undefined;
  verbose: boolean;
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
}

const getDeployer = async (configFilename: string) => {
  await cryptoWaitReady();
  let keyring = new Keyring({ type: 'sr25519' });
  try {
    const config = await readJSON(configFilename);
    if (config.variant === 'frontier') keyring = new Keyring({ type: 'ethereum' });
    return keyring.createFromUri(config.deployer.privateKey);
  } catch (_) {
    return keyring.createFromUri(ethers.Wallet.createRandom().privateKey);
  }
}

const setConfig = async (configFilename: string, deployer: KeyringPair) => {
  // @ts-ignore
  let url = network.config.url;
  let config: TPSConfig = {
    tpsServerHost: "0.0.0.0",
    tpsServerPort: 8181,
    endpoint: url || "http://127.0.0.1:9944",
    variant: "substrate",
    deployer: {
      address: deployer.address,
      privateKey: deployer.address,
    },
    fundSenders: true,
    accounts: 100,
    workers: 80,
    sendRawTransaction: true,
    timeout: 5000,
    tokenAddress: "",
    tokenMethod: "transferLoop",
    tokenAmountToMint: 1_000_000_000,
    tokenTransferMultiplier: 1,
    tokenAssert: true,
    transactions: 30_000,
    gasLimit: "200000",
    txpoolMaxLength: -1,
    txpoolMultiplier: 2,
    txpoolLimit: 7500,
    checkersInterval: 250,
    estimate: false,
    payloads: undefined,
    verbose: false,
  };

  if (fs.existsSync(configFilename)) {
    const fromJSON = await readJSON(configFilename);
    config = { ...config, ...fromJSON };
  }

  await promisify(fs.writeFile)(configFilename, JSON.stringify(config, null, 2));

  return config;
}

const setTxpool = async (config: TPSConfig, deployer: KeyringPair) => {
  if (config.txpoolMaxLength === -1) {
    // We pre calculate the max txn per block we can get and set the txpool max size to * txpoolMultiplier of it.
    const api = await substrateApi.get(config);
    // @ts-ignore
    let blockWeight = api.consts.system.blockWeights.maxBlock;
    console.log(`\n[Txpool] Trying to get a proper Txpool max length...`);
    // @ts-ignore
    let blockMaxFee = (await api.call.transactionPaymentApi.queryWeightToFee(blockWeight)).toBigInt();
    blockMaxFee = blockMaxFee * 3n / 4n;
    console.log(`[Txpool] Block Max Fee    : ${blockMaxFee}`);
    const xt = api.tx.balances.transferKeepAlive(deployer.address, 1_000);
    const info = await xt.paymentInfo(deployer);
    console.log(`[Txpool] Extrinsic Fee    : ${info.partialFee}`);
    let max_txn_block = parseInt((blockMaxFee / info.partialFee.toBigInt()).toString());
    console.log(`[Txpool] Max xts per Block: ${Math.round(max_txn_block)}`);
    let maxTxnMultiplier = max_txn_block * config.txpoolMultiplier;
    if (maxTxnMultiplier > 5000) config.txpoolMaxLength = Math.round(maxTxnMultiplier / 1000) * 1000;
    else config.txpoolMaxLength = maxTxnMultiplier;
    console.log(`[Txpool] Max length       : ${config.txpoolMaxLength}`);
    if (config.txpoolMaxLength > config.txpoolLimit) {
      config.txpoolMaxLength = config.txpoolLimit;
      console.log(`[Txpool] Using pool limit : ${config.txpoolMaxLength} ***`);
    }
  }
  return config;
}

const setupAccounts = async (
  config: TPSConfig,
  sendersFilename: string,
  receiversFilename: string
) => {

  await cryptoWaitReady();
  let keyring = new Keyring({ type: 'sr25519' });
  if (config.variant === 'frontier') keyring = new Keyring({ type: 'ethereum' });

  let account: KeyringPair | null = null;
  try {
    let keysByIds = await readJSON(sendersFilename);
    console.log(`[setupAccounts] Reading ${Object.keys(keysByIds).length} senders' accounts...`);
    for (let k of Object.keys(keysByIds)) {
      account = keyring.createFromUri(keysByIds[k].privateKey);
      sendersMap.set(parseInt(k), account);
    }

    keysByIds = await readJSON(receiversFilename);
    console.log(`[setupAccounts] Reading ${Object.keys(keysByIds).length} receivers' accounts...`);
    for (let k of Object.keys(keysByIds)) {
      account = keyring.createFromUri(keysByIds[k].privateKey);
      receiversMap.set(parseInt(k), account);
    }

    return;
  } catch (error: any) { }

  let senders: any = {};
  let receivers: any = {};
  console.log(`[setupAccounts] Creating ${config.accounts} senders and ${config.accounts} receivers accounts...`);
  for (let k = 0; k < config.accounts; k++) {
    let randomWallet = ethers.Wallet.createRandom();
    account = keyring.createFromUri(randomWallet.privateKey);
    sendersMap.set(k, account);
    senders[k] = { address: account.address, privateKey: randomWallet.privateKey };

    randomWallet = ethers.Wallet.createRandom();
    account = keyring.createFromUri(randomWallet.privateKey);
    receiversMap.set(k, account);
    receivers[k] = { address: account.address, privateKey: randomWallet.privateKey };
  }

  await promisify(fs.writeFile)(sendersFilename, JSON.stringify(senders, null, 2));
  await promisify(fs.writeFile)(receiversFilename, JSON.stringify(receivers, null, 2));
}

const post = async (config: TPSConfig, method: string, params: any[]) => {
  let r = await axios.post(
    config.endpoint,
    {
      jsonrpc: "2.0",
      method,
      params,
      id: 1
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: config.timeout },
  );
  return r.data;
}

const waitForResponse = async (config: TPSConfig, method: string, params: any[], delay: number, retries: number) => {
  let result;
  for (let counter = 0; counter < retries; counter++) {
    try {
      let r = await post(config, method, params);
      result = r.result;
      if (result) break;
    } catch (err: any) { console.log(`ERROR: waitForResponse() -> ${err}`) }
    counter++;
    if (counter >= retries) break;
    await new Promise(r => setTimeout(r, delay));
  }
  return result;
}

const batchSendNativeToken = async (config: TPSConfig, deployer: KeyringPair) => {
  const api = await substrateApi.get(config);
  let nonce = await api.rpc.system.accountNextIndex(deployer.address);
  let txHash;
  for (let k = 0; k < sendersMap.size; k++) {
    const sender = sendersMap.get(k)!;
    txHash = (await api.tx.balances.transfer(sender.address, 1_000_000_000_000_000).signAndSend(deployer, { nonce })).toString();
    if (!validTxHash(txHash)) throw Error(`[ERROR] batchSendNativeToken() -> ${JSON.stringify(txHash)}`);
    console.log(`[batchSendNativeToken] Sending Native Token to ${sender.address} -> ${txHash}`);
    if ((k + 1) % 500 === 0) await new Promise(r => setTimeout(r, 6000));
    // @ts-ignore
    nonce = nonce.add(new BN(1));
  }
  await getReceiptLocally(txHash!, 500, 60);
}

const submitExtrinsic = async (api: ApiPromise, k: number, nonce: number) => {
  const sender = sendersMap.get(k)!;
  const receiver = receiversMap.get(k)!;

  const txHash = (await api.tx.balances.transferKeepAlive(receiver.address, 1_000).signAndSend(sender, { nonce })).toString();
  if (!validTxHash(txHash)) throw Error(`[ERROR] submitExtrinsic() -> ${JSON.stringify(txHash)}`);

  return txHash;
}

const blockTracker = async (config: TPSConfig) => {
  const api = await substrateApi.get(config);
  // @ts-ignore
  let blockMaxWeights = api.consts.system.blockWeights.maxBlock.refTime;
  blockMaxWeights = blockMaxWeights.toNumber() * 0.75;
  let blockNumber = 0;
  const unsubscribe = await api.rpc.chain.subscribeNewHeads(async (header) => {
    if (blockNumber != header.number.toNumber()) {
      const block = (await api.rpc.chain.getBlock(header.hash)!).block;
      // @ts-ignore
      let weight = (await (await api.at(header.hash)).query.system.blockWeight()).normal.refTime.toNumber();
      let ratio = Math.round((weight / blockMaxWeights) * 100);
      let msg = `[BlockTracker] Block: ${zeroPad(header.number.toNumber(), 4)} | `;
      msg += `xts: ${zeroPad(block.extrinsics.length, 4)} | `;
      msg += `weight: ${zeroPad(weight, 13)} (~${zeroPad(ratio, 3)}%) `;
      msg += `[fee: ${printGasPrice(chainFee)} | pool: ${zeroPad(txPoolLength, 5)}]`;
      if (lastTxHash && !config.verbose) msg += ` -> xtHash: ${lastTxHash} `;
      console.log(msg);
      blockNumber = header.number.toNumber();
    }
  });
}

const getReceiptLocally = async (txnHash: string, delay: number, retries: number) => {
  let receipt;
  for (let counter = 0; counter < retries; counter++) {
    try {
      receipt = receiptsMap.get(txnHash);
      if (receipt !== undefined) break;
    } catch { }
    counter++;
    if (counter >= retries) break;
    await new Promise(r => setTimeout(r, delay));
  }
  return receipt;
}

const txpoolChecker = async (config: TPSConfig) => {
  let method = "author_pendingExtrinsics";
  if (config.variant === "geth") method = "txpool_content";
  else if (config.variant === "parity") method = "parity_pendingTransactions";

  while (1) {
    try {
      let result = await waitForResponse(config, method, [], 250, 1);
      if (config.variant === "geth") {
        let pending: any = [];
        for (let k of Object.keys(result.pending)) {
          pending = pending.concat(Object.keys(result.pending[k]));
        }
        txPoolLength = pending.length;
      } else txPoolLength = result.length;
    } catch { txPoolLength = -1; }
    await new Promise(r => setTimeout(r, config.checkersInterval));
  }
}

const feeChecker = async (config: TPSConfig) => {
  const api = await substrateApi.get(config);
  let deployer = await getDeployer(EVM_TPS_CONFIG_FILE);
  const xt = api.tx.balances.transferKeepAlive(deployer.address, 1_000);
  while (1) {
    try {
      let { partialFee: fee } = await xt.paymentInfo(deployer);
      chainFee = ethers.BigNumber.from(fee.toBigInt());
    } catch { }
    await new Promise(r => setTimeout(r, config.checkersInterval));
  }
}

const printGasPrice = (value: BigNumber) => {
  let normalized = `${Math.round(value.div(1_000_000).toNumber())}M`;
  if (value.gte(1_000_000_000)) normalized = `${Math.round(value.div(1_000_000_000).toNumber())}B`;
  if (value.gte(1_000_000_000_000)) normalized = `${Math.round(value.div(1_000_000_000_000).toNumber())}T`;
  if (value.gte(1_000_000_000_000_000)) normalized = `${Math.round(value.div(1_000_000_000_000_000).toNumber())}Q`;
  return normalized;
}

const checkTxpool = async (config: TPSConfig) => {
  if (config.txpoolMaxLength > 0) {
    while (txPoolLength === -1 || txPoolLength >= config.txpoolMaxLength) {
      await new Promise(r => setTimeout(r, 5));
    }
  }
}

const checkBalances = async (config: TPSConfig, deployer: KeyringPair) => {
  const api = await substrateApi.get(config);
  const sender = sendersMap.get(0)!;
  // @ts-ignore
  let { data: { free: balance } } = await api.query.system.account(sender.address);
  console.log(`[checkBalances] ${sender.address} Native Token balance: ${balance}`);
  if (balance == 0) await batchSendNativeToken(config, deployer);
}

const assertTokenBalances = async (config: TPSConfig) => {
  const api = await substrateApi.get(config);
  let diffs = 0;
  for (let k = 0; k < config.accounts; k++) {
    const amounts = rcvBalances.get(k)!;
    const receiver = receiversMap.get(k)!;
    // @ts-ignore
    let { data: { free: amount } } = await api.query.system.account(receiver.address);
    const ok = amounts.after === amount.toNumber();
    if (!ok) diffs++;
  }
  if (diffs > 0) console.log(`[assertTokenBalances][ERROR] Balance is different for ${diffs} receivers. ***`);
  else console.log(`[assertTokenBalances] OK`);
}

const updateNonces = async (config: TPSConfig) => {
  const api = await substrateApi.get(config);
  for (let k = 0; k < config.accounts; k++) {
    const sender = sendersMap.get(k)!;
    const nonce = await api.rpc.system.accountNextIndex(sender.address);
    console.log(`[updateNonces] ${sender.address} -> ${nonce}`);
    nonceMap.set(k, nonce.toNumber());
  }
}

const updateBalances = async (config: TPSConfig) => {
  const api = await substrateApi.get(config);
  for (let k = 0; k < config.accounts; k++) {
    const receiver = receiversMap.get(k)!;
    // @ts-ignore
    let { data: { free: balance } } = await api.query.system.account(receiver.address);
    console.log(`[updateBalances] ${receiver.address} -> ${balance}`);
    rcvBalances.set(k, { before: balance.toNumber(), after: balance.toNumber() });
  }
}

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
  // workersAPIMap.clear();
  sendersErrMap.clear();
  reqErrorsMap.clear();
  initNumberMap(sendersErrMap, config.accounts, 0);
  initNumberMap(sendersTxnMap, config.accounts, 0);
  initNumberMap(sendersFreeMap, config.accounts, true);
  lastTxHash = "";
}

const setupDirs = () => {
  try {
    fs.mkdirSync(EVM_TPS_ROOT_DIR);
  } catch (error: any) {
    if (error.code !== "EEXIST") {
      console.error(`[ERROR] Failed to create directories [${EVM_TPS_ROOT_DIR}]: ${error.message}`);
      process.exit(1);
    }
  }
}

const calculateTPS = async (config: TPSConfig, startingBlock: SimpleBlock) => {
  const api = await substrateApi.get(config);

  let lastBlock = await getBlockWithExtras(api, null);

  let lastBlockNumber = lastBlock.number;
  while (lastBlock.extrinsics.length > inherentExtrinsics || lastBlock.number === startingBlock.number) {
    lastBlockNumber = lastBlock.number;
    await new Promise(r => setTimeout(r, 200));
    lastBlock = await getBlockWithExtras(api, null);
  }

  lastBlock = await getBlockWithExtras(api, lastBlockNumber);

  let t = lastBlock.timestamp - startingBlock.timestamp;
  let err = `[errors=${reqErrorsMap.size}]`;
  let blocks = lastBlock.number - startingBlock.number;
  return `blocks=${blocks} (${startingBlock.number + 1} -> ${lastBlock.number}) | txns=${config.transactions} t=${t} -> ${(config.transactions / t)} TPS/RPS ${err}`;
}

const initNumberMap = (m: Map<number, any>, length: number, value: any) => {
  for (let i = 0; i < length; i++) m.set(i, value);
}

const printNumberMap = (m: Map<number, any>) => {
  let msg = "\n\n";
  for (let i = 0; i < m.size; i++) msg += `\n[printMap][${zeroPad(i, 5)}] ${m.get(i)!}`;
  msg += "\n\n"
  return msg;
}

const getBlockWithExtras = async (api: ApiPromise, number: number | null): Promise<SimpleBlock> => {
  let hash, block, timestamp;
  if (number) {
    hash = (await api.rpc.chain.getBlockHash(number)!);
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
  }
}

const getAvailSender = async (config: TPSConfig, key: number) => {
  const maxTxnPerSender = Math.ceil(config.transactions / config.accounts);
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
    await new Promise(r => setTimeout(r, 1));
  }
  return -1;
}

const getFreeWorker = async (config: TPSConfig, workerId: number) => {
  workerId = workerId === 0 ? workerId : workerId + 1;
  if (workerId >= config.workers) workerId = 0;
  while (workersMap.get(workerId)!) {
    await new Promise(r => setTimeout(r, 1));
    workerId++;
    if (workerId >= config.workers) workerId = 0;
  }
  return workerId;
}

const validTxHash = (txHash: string | undefined) => {
  if (txHash === undefined || txHash === null) return false;
  if (!txHash?.startsWith('0x')) return false;
  if (txHash?.length !== 66) return false;
  return true;
}

const resendAuto = async (config: TPSConfig, workerId: number) => {
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
      autoSendRawTransaction(config, workerId, k, nonce);
      nonce++;
    }
    nonceMap.set(k, nonce);
  }
}

const autoSendRawTransaction = async (
  config: TPSConfig,
  workerId: number,
  senderKey: number,
  nonce: number,
) => {
  sendersBusyMap.set(senderKey, true);
  workersMap.set(workerId, true);
  const api = workersAPIMap.get(workerId)!;

  const pre = `[req: ${zeroPad(reqCounter, 5)}][addr: ${zeroPad(senderKey, 5)}]`;
  let post = `[wrk: ${zeroPad(workerId, 5)}(len=${zeroPad(workersMap.size, 5)}) `;
  post += `nonce: ${zeroPad(nonce, 5)} | `;
  post += `fee: ${printGasPrice(chainFee)} | `;
  post += `pool: ${zeroPad(txPoolLength, 5)} | err=${reqErrorsMap.size}]`;
  let msg = "";

  const start = Date.now();
  try {
    const txHash = await submitExtrinsic(api, senderKey, nonce);
    if (validTxHash(txHash)) {
      const t = Date.now() - start;
      const postWithTime = `${post} [time: ${zeroPad(t, 5)}${t > 12000 ? " ***" : ""}]`;
      msg = `${pre} auto: ${txHash} ${postWithTime}`;
      if (config.verbose) console.log(msg);

      lastTxHash = txHash;
      let nextNonce = nonce + 1;
      nonceMap.set(senderKey, nextNonce);

      let amounts = rcvBalances.get(senderKey)!;
      amounts.after += 1_000;
      rcvBalances.set(senderKey, amounts);
    } else { throw Error(`Invalid txHash: ${txHash}`) }
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
}

const auto = async (config: TPSConfig) => {
  let status_code = 0;
  let msg = "";
  const start = Date.now();
  let workerId = 0;
  try {
    const api = await substrateApi.get(config);
    let startingBlock = await getBlockWithExtras(api, null);
    let initialCounter = reqCounter;

    while ((reqCounter - initialCounter) < config.transactions) {
      if (hardstop) {
        hardstop = false;
        return [0, "HARD_STOP"];
      }
      // 5% of errors is too much, something is wrong.
      if (reqErrorsMap.size >= (config.transactions * 0.05)) {
        console.log(printNumberMap(reqErrorsMap));
        let p = Math.round((reqErrorsMap.size / config.transactions) * 100);
        return [0, `TOO_MANY_ERRORS: ${reqErrorsMap.size}/${config.transactions} [~${p}%]`];
      }
      await checkTxpool(config);
      nextKey = await getAvailSender(config, nextKey);
      if (nextKey === -1 || sendersFreeMap.size === 0) break;
      workerId = await getFreeWorker(config, workerId);
      const nonce = nonceMap.get(nextKey)!;
      reqCounter++;
      autoSendRawTransaction(config, workerId, nextKey, nonce);
      sendersTxnMap.set(nextKey, sendersTxnMap.get(nextKey)! + 1);
    }

    // Wait till no more running workers.
    while (workersMap.size > 0) { await new Promise(r => setTimeout(r, 5)) };

    while (reqErrorsMap.size > 0) await resendAuto(config, workerId);

    while (txPoolLength > 0) await new Promise(r => setTimeout(r, 100));

    // Wait till no more running workers.
    while (workersMap.size > 0) { await new Promise(r => setTimeout(r, 5)) };

    let tpsResult = await calculateTPS(config, startingBlock);
    reqErrorsMap.clear();
    reqErrCounter = 0;

    if (config.tokenAssert) await assertTokenBalances(config);

    lastTxHash = "";

    let t = Date.now() - start;
    let pre = `[req: ${zeroPad(reqCounter, 5)}][addr: ${zeroPad(0, 5)}]`;
    let post = `[wrk: ${zeroPad(workersMap.size, 5)} | pool: ${zeroPad(txPoolLength, 5)} | time: ${zeroPad(t, 5)}]`;
    msg = `${pre} auto: ${tpsResult} ${post}`;
  } catch (error: any) {
    msg = `[ERROR][req: ${zeroPad(reqCounter, 5)}][wrk: ${zeroPad(workersMap.size, 5)}] auto: ${error.message}`;
  }
  console.log(msg);
  return [status_code, msg];
}

const setup = async () => {
  setupDirs();

  let deployer = await getDeployer(EVM_TPS_CONFIG_FILE);
  let config = await setConfig(EVM_TPS_CONFIG_FILE, deployer);

  resetMaps(config);

  if (workersAPIMap.size == 0) {
    for (let i = 0; i < config.workers; i++) {
      // We need an API for each worker
      const subs = new SubstrateApi('');
      const api = await subs.get(config);
      workersAPIMap.set(i, api);
    }
  }

  await setupAccounts(config, EVM_TPS_SENDERS_FILE, EVM_TPS_RECEIVERS_FILE);

  const api = await substrateApi.get(config);
  let block = await getBlockWithExtras(api, null);
  inherentExtrinsics = block.extrinsics.length;

  if (config.fundSenders) await checkBalances(config, deployer);

  await updateNonces(config);
  await updateBalances(config);

  config = await setTxpool(config, deployer);

  console.log(JSON.stringify(config, null, 2));

  hardstop = false;

  return config!;
}

const main = async () => {

  let config = await setup();

  blockTracker(config);
  txpoolChecker(config);

  feeChecker(config);

  const app = express();
  app.use(BodyParser.json());

  app.get("/auto", async (req: any, res: any) => {
    config = await setup();
    console.log(`[Server] Running auto()...`);
    const [status, msg] = await auto(config);
    if (status === 0) res.send(msg);
    else res.status(500).send(`Internal error: /auto ${msg}`);
  });

  app.get("/stats", async (req: any, res: any) => {
    try {
      const stats = {
        senders: sendersMap.size,
        receivers: receiversMap.size,
        receipts: receiptsMap.size,
        nonces: nonceMap.size,
        workers: workersMap.size,
        reqCounter,
        errors: reqErrorsMap.size,
      }
      const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] status: \n${JSON.stringify(stats, null, 2)}\n`;
      console.log(msg);
      res.send(msg);
    } catch (error: any) {
      console.error(`[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] reset: ${error.message}`);
      res.status(500).send(`Internal error: /stats ${error.message}`);
    }
  });

  app.get("/reset", async (req: any, res: any) => {
    try {
      const start = Date.now();
      config = await setup();
      const t = Date.now() - start;
      const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] reset: [b: - | t: ${t}]`;
      console.log(msg);
      res.send(msg);
    } catch (error: any) {
      console.error(`[ERROR][req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] reset: ${error.message}`);
      res.status(500).send(`Internal error: /reset ${error.message}`);
    }
  });

  app.get("/dumpErrors", async (req: any, res: any) => {
    try {
      const msg = `----- dumpErrors: ${printNumberMap(reqErrorsMap)}`;
      console.log(msg);
      res.send(msg);
    } catch (error: any) {
      res.status(500).send(`Internal error: /dumpErrors ${error.message}`);
    }
  });

  app.get("/stop", async (req: any, res: any) => {
    try {
      const start = Date.now();
      hardstop = true;
      const t = Date.now() - start;
      const msg = `[req: ${zeroPad(reqCounter, 5)}][acc: ${zeroPad(-1, 5)}] stop: [b: - | t: ${t}]`;
      console.log(msg);
      res.send(msg);
    } catch (error: any) {
      res.status(500).send(`Internal error: /stop ${error.message}`);
    }
  });

  app.listen(config.tpsServerPort, config.tpsServerHost, () => {
    console.log(`> Listening at http://${config.tpsServerHost}:${config.tpsServerPort}`);
  });
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
