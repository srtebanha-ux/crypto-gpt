// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/** ONLY local EVM tests, never deploy these to production. */
interface ITitanMockTokenV3 {
 function transferFrom(address,address,uint256) external returns(bool);
 function transfer(address,uint256) external returns(bool);
}
contract TitanMockV3Pool {}
contract TitanMockV3Factory {
 mapping(bytes32=>address) public pools;
 function key(address a,address b,uint24 fee) public pure returns(bytes32) {
  return keccak256(abi.encode(a<b?a:b,a<b?b:a,fee));
 }
 function setPool(address a,address b,uint24 fee,address pool) external {
  pools[key(a,b,fee)]=pool;
 }
 function getPool(address a,address b,uint24 fee) external view returns(address) {
  return pools[key(a,b,fee)];
 }
}
contract TitanMockV3Router02 {
 uint256 public outputBps=10000;
 function setOutputBps(uint256 x) external {require(x<=20000);outputBps=x;}
 struct ExactInputSingleParams {
  address tokenIn;address tokenOut;uint24 fee;address recipient;
  uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;
 }
 struct ExactInputParams {
  bytes path;address recipient;uint256 amountIn;uint256 amountOutMinimum;
 }
 function exactInput(ExactInputParams calldata x) external returns(uint256 amountOut) {
  require(x.path.length==66,"path must be 2 hops");
  bytes memory data=x.path;
  address first;
  address last;
  assembly {
   first := shr(96,mload(add(data,32)))
   last := shr(96,mload(add(data,78)))
  }
  require(first!=last && first!=address(0)&&last!=address(0),"bad path");
  require(ITitanMockTokenV3(first).transferFrom(msg.sender,address(this),x.amountIn));
  amountOut=x.amountIn*outputBps/10000;
  require(amountOut>=x.amountOutMinimum,"amountOutMinimum");
  require(ITitanMockTokenV3(last).transfer(x.recipient,amountOut));
 }
 function exactInputSingle(ExactInputSingleParams calldata x) external returns(uint256 amountOut) {
  require(x.sqrtPriceLimitX96==0,"partial fill disallowed");
  require(ITitanMockTokenV3(x.tokenIn).transferFrom(msg.sender,address(this),x.amountIn));
  amountOut=x.amountIn*outputBps/10000;
  require(amountOut>=x.amountOutMinimum,"amountOutMinimum");
  require(ITitanMockTokenV3(x.tokenOut).transfer(x.recipient,amountOut));
 }
}
