import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const optimizerSettings = {
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    outputSelection: {
      "*": {
        "*": ["devdoc", "userdoc", "metadata"],
        "": [],
      },
    },
  },
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.18",
        ...optimizerSettings
      }
    ]
  },
  defaultNetwork: "local",
  networks: {
    local: {
      url: "http://127.0.0.1:9933",
      accounts: [
        "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133",
        "0x99B3C12287537E38C90A9219D4CB074A89A16E9CDB20BF85728EBD97C343E342",
        "0xE2033D436CE0614ACC1EE15BD20428B066013F827A15CC78B063F83AC0BAAE64",
      ],
    },
  },
};

export default config;
