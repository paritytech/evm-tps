// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract SimpleNFT is ERC721 {

    address public owner;
    uint256 private itemId = 0;

    constructor(
        string memory _name,
        string memory _symbol
    ) ERC721(_name, _symbol) {
        owner = msg.sender;
    }

    function mintTo(address _to) public {
        require(msg.sender == owner, "Only owner is allowed to mint.");
        _mint(_to, itemId);
        itemId += 1;
    }

}