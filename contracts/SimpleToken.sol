// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract SimpleToken is ERC20 {
    address public owner;
    bool public paused = true;
    mapping(address => uint) public map;

    modifier whenNotPaused() {
        require(!paused, "Onwer has not started the contract yet.");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        owner = msg.sender;
    }

    // Dummy logic just to get revert msg here and in the mintTo() if wanted.
    function start() public {
        require(msg.sender == owner, "Only owner can start it.");
        paused = false;
    }

    function pause() public {
        require(msg.sender == owner, "Only owner can pause it.");
        paused = true;
    }

    function mintTo(address _to, uint _amount) public whenNotPaused {
        _mint(_to, _amount);
    }

    // n=1      55k
    // n=10     66k
    // n=100    355k
    // n=250    833k
    // n=500    1.63M
    // n=1000   3.23M
    function transferLoop(
        uint16 n,
        address _to,
        uint _amount
    ) public whenNotPaused {
        for (uint16 i = 0; i < n; i++) {
            transfer(_to, _amount);
        }
    }

    // n=1      27k
    // n=10     46k
    // n=100    240k
    // n=250    561k
    // n=500    1.10M
    // n=1000   2.17M
    function eventLoop(
        uint16 n,
        address _to,
        uint _amount
    ) public whenNotPaused {
        for (uint16 i = 0; i < n; i++) {
            emit Transfer(msg.sender, _to, _amount);
        }
    }

    // n=1      30k
    // n=10     37k
    // n=100    100k
    // n=250    205k
    // n=500    380k
    // n=1000   745k
    function storageLoop(
        uint16 n,
        address _to,
        uint _amount
    ) public whenNotPaused {
        for (uint16 i = 0; i < n; i++) {
            map[_to] += _amount;
        }
    }
}
