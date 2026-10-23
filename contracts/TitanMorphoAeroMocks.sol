// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/** Local EVM mocks ONLY; never deploy these on Base. */
interface IAeroMockToken {
 function transferFrom(address,address,uint256) external returns(bool);
 function transfer(address,uint256) external returns(bool);
}
contract AeroPoolMock {}
contract AeroFactoryMock {
 mapping(bytes32=>address) private pools;
 function key(address a,address b,bool stable) public pure returns(bytes32){
  return keccak256(abi.encode(a<b?a:b,a<b?b:a,stable));
 }
 function setPool(address a,address b,bool stable,address pool) external{
  pools[key(a,b,stable)]=pool;
 }
 function getPool(address a,address b,bool stable) external view returns(address){
  return pools[key(a,b,stable)];
 }
}
contract AeroRouterMock {
 uint256 public outputBps=10000;
 struct Route{address from;address to;bool stable;address factory;}
 function setOutputBps(uint256 x) external{require(x<=20000);outputBps=x;}
 function swapExactTokensForTokens(
  uint256 amountIn,uint256 minOut,Route[] calldata routes,
  address recipient,uint256 deadline
 ) external returns(uint256[] memory outputs){
  require(deadline>=block.timestamp&&(routes.length==1||routes.length==2),"bad path");
  require(IAeroMockToken(routes[0].from).transferFrom(msg.sender,address(this),amountIn));
  outputs=new uint256[](routes.length+1);outputs[0]=amountIn;
  uint256 out=amountIn;
  for(uint256 i=0;i<routes.length;i++){
   if(i>0)require(routes[i-1].to==routes[i].from,"disconnected");
   out=out*outputBps/10000;outputs[i+1]=out;
  }
  require(out>=minOut,"INSUFFICIENT_OUTPUT_AMOUNT");
  require(IAeroMockToken(routes[routes.length-1].to).transfer(recipient,out));
 }
}
