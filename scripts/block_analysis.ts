const getLastBlocks = async (n) => {
  let last = await ethers.provider.getBlock();
  let tLast = last.timestamp;
  let totalTxn = 0;
  let gasUsageSum = 0;
  let b;
  for (let i = 0; i < n; i++) {
    b = await ethers.provider.getBlock(last.number - i);
    totalTxn += b.transactions.length;
    console.log(`number: ${b.number}, miner: ${b.miner}, gasUsed: ${b.gasUsed}, gasUsed/gasLimit: ${b.gasUsed / b.gasLimit}, txs: ${b.transactions.length}`);
    gasUsageSum += b.gasUsed / b.gasLimit;
  }
  let t0 = b.timestamp;
  let diff = tLast - t0;
  let avgTps = totalTxn / diff;
  let avgGasUsage = gasUsageSum / n;
  console.log(`total tx: ${totalTxn}`);
  console.log(`average TPS: ${avgTps}`);
  console.log(`average gas usage: ${avgGasUsage}`);
};

getLastBlocks(100);
