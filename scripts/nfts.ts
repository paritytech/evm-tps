import { ethers } from 'hardhat';

const axios = require('axios');

const post = async (method, params) => {
    let r = await axios.post(
        'http://127.0.0.1:9933',
        {
            jsonrpc: '2.0',
            method,
            params,
            id: 1,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return r.data;
};

// Alith
const deployer = new ethers.Wallet(
    '0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133',
    ethers.provider
);
// Baltathar
const bal = new ethers.Wallet(
    '0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b',
    ethers.provider
);

const gasLimit = ethers.BigNumber.from(200_000);

export const deployNfts = async (amount: number): Promise<string> => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const gasPrice = await ethers.provider.getGasPrice();

    // Mint -----

    const SimpleNFT = await ethers.getContractFactory('SimpleNFT', deployer);
    const nft = await SimpleNFT.deploy('SimpleTokenNFT', 'STK', { gasLimit: 2_000_000, gasPrice });
    let tx = await nft.deployed();
    console.log(`SimpleNFT deployed to ${nft.address}`);

    const receiverAddr = '0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0';
    let nonce = await deployer.getTransactionCount();
    for (let i = 0; i < amount; i++) {
        let unsigned = await nft.populateTransaction.mintTo(receiverAddr);
        unsigned = {
            ...unsigned,
            gasLimit,
            gasPrice,
            nonce,
            chainId,
        };
        let payload = await deployer.signTransaction(unsigned);
        let data = await post('eth_sendRawTransaction', [payload]);
        let txHash = data.result;
        console.log(`[mintTo] ${receiverAddr} | ${nonce} -> ${txHash}`);
        nonce++;
    }

    return nft.address;
};

export const transferNfts = async (nftAddress: string, amount: number) => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const gasPrice = await ethers.provider.getGasPrice();

    const nftBal = (await ethers.getContractFactory('SimpleNFT', bal)).attach(nftAddress);
    let nonce = await bal.getTransactionCount();
    let tokenId = 0;
    for (let i = 0; i < amount; i++) {
        let unsigned = await nftBal.populateTransaction.transferFrom(
            bal.address,
            deployer.address,
            tokenId
        );
        unsigned = {
            ...unsigned,
            gasLimit,
            gasPrice,
            nonce,
            chainId,
        };
        let payload = await bal.signTransaction(unsigned);
        let data = await post('eth_sendRawTransaction', [payload]);
        let txHash = data.result;
        console.log(`[transferFrom] ${bal.address} to ${deployer.address} | ${nonce} -> ${txHash}`);
        nonce++;
        tokenId++;
    }
};
