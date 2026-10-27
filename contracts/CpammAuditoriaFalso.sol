// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
// SOMENTE TESTES: tokens e pares controlados para reproduzir falhas de pagamento.
interface ICallbackCpammTeste {function uniswapV2Call(address,uint256,uint256,bytes calldata) external;}
contract TokenCpammTeste {
    mapping(address=>uint256) public balanceOf;
    address public destinoTaxado;
    function mint(address to,uint256 n) external {balanceOf[to]+=n;}
    function taxar(address to) external {destinoTaxado=to;}
    function transfer(address to,uint256 n) external returns(bool){
        require(balanceOf[msg.sender]>=n,"balance");balanceOf[msg.sender]-=n;
        balanceOf[to]+=to==destinoTaxado?n*95/100:n;return true;
    }
}
contract ParCpammTeste {
    address public immutable token0; address public immutable token1; address public immutable factory;
    uint112 private r0;uint112 private r1;
    constructor(address a,address b){token0=a;token1=b;factory=msg.sender;}
    function sync() external {r0=uint112(TokenCpammTeste(token0).balanceOf(address(this)));r1=uint112(TokenCpammTeste(token1).balanceOf(address(this)));}
    function getReserves() external view returns(uint112,uint112,uint32){return(r0,r1,0);}
    function swap(uint256 a0,uint256 a1,address to,bytes calldata data) external {
        require(a0<r0&&a1<r1,"liquidity");
        if(a0>0)TokenCpammTeste(token0).transfer(to,a0);
        if(a1>0)TokenCpammTeste(token1).transfer(to,a1);
        if(data.length>0)ICallbackCpammTeste(to).uniswapV2Call(msg.sender,a0,a1,data);
        uint256 b0=TokenCpammTeste(token0).balanceOf(address(this));
        uint256 b1=TokenCpammTeste(token1).balanceOf(address(this));
        uint256 in0=b0>r0-a0?b0-(r0-a0):0;
        uint256 in1=b1>r1-a1?b1-(r1-a1):0;
        require((b0*1000-in0*3)*(b1*1000-in1*3)>=uint256(r0)*r1*1e6,"UniswapV2: K");
        r0=uint112(b0);r1=uint112(b1);
    }
}
contract FactoryCpammTeste {
    address public pair;
    function criar(address a,address b) external {pair=address(new ParCpammTeste(a,b));}
    function getPair(address a,address b) external view returns(address){
        ParCpammTeste p=ParCpammTeste(pair);
        return (a==p.token0()&&b==p.token1())||(b==p.token0()&&a==p.token1())?pair:address(0);
    }
}
contract OracleL1CpammTeste {
    function getL1FeeUpperBound(uint256) external pure returns(uint256){return 1000;}
}
