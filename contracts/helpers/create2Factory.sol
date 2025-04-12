// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

contract Create2Factory {
	event Deployed(address addr, uint256 salt);

	constructor() {}

	function deploy(bytes memory bytecode, uint256 salt) public returns (address) {
		address addr;
		assembly {
			addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
			if iszero(extcodesize(addr)) {
				revert(0, 0)
			}
		}
		emit Deployed(addr, salt);
		return addr;
	}

	function getAddress(bytes memory bytecode, uint256 salt) public view returns (address) {
		bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)));
		return address(uint160(uint256(hash)));
	}
}
