#!/bin/bash

MODE="$1"
EVM_TPS_PATH="$2"

set_balances() {
  echo "Setting up balances mode..."
  rm data/config.json
  rm balances.log
  cp data/config.balances.json data/config.json
}

set_assets() {
  echo "Setting up assets mode..."
  rm data/config.json
  rm assets.log
  cp data/config.assets.json data/config.json
}

set_nfts() {
  echo "Setting up NFTs mode..."
  rm data/config.json
  rm nfts.log
  cp data/config.nfts.json data/config.json
}

set_erc20() {
  echo "Setting up ERC20 mode..."
  rm data/config.json
  rm erc20.log
  cp data/config.erc20.json data/config.json
}

set_erc721() {
  echo "Setting up ERC721 mode..."
  rm data/config.json
  rm erc721.log
  cp data/config.erc721.json data/config.json
}

if [ -z "$EVM_TPS_PATH" ]; then
    echo "EVM_TPS_PATH environment variable is not set. Executing as local script"
else
  pushd $EVM_TPS_PATH
  yarn
fi

case "$MODE" in
  "balances")
    set_balances
    yarn substrate 2>&1 | tee balances.log
    ;;
  "assets")
    set_assets
    yarn substrate 2>&1 | tee assets.log
    ;;
  "nfts")
    set_nfts
    yarn substrate 2>&1 | tee nfts.log
    ;;
  "erc20")
    set_erc20
    yarn evm 2>&1 | tee erc20.log
    ;;
  "erc721")
    set_erc721
    yarn evm 2>&1 | tee erc721.log
    ;;
  *)
    echo "Error: '$MODE' is not a valid mode. Please use one of: balances, assets, nfts, erc20, erc721"
    exit 1
    ;;
esac

popd