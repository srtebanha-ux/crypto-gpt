// Read-only Base Atlas protocol inspection. No wallet/private-key access.
const {Interface}=require('ethers');
const I=new Interface(['function VERIFICATION() view returns(address)','function getSolverGasLimit() view returns(uint256)']);
console.log('Atlas VERIFICATION selector',I.getFunction('VERIFICATION').selector);
console.log('DAppControl gas-limit selector',I.getFunction('getSolverGasLimit').selector);
