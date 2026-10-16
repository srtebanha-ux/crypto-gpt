// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/** Mock LOCAL Aerodrome volatile: getAmountOut e swap com entrada pre-transferida. */
interface ITokenAerotest {
    function balanceOf(address) external view returns(uint256);
    function transfer(address,uint256) external returns(bool);
}
contract TitanAeroMultiTeste {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable num;
    uint256 public immutable den;
    uint256 private reserva0;
    uint256 private reserva1;
    constructor(address t0,address t1,uint256 n,uint256 d) {
        token0=t0;token1=t1;num=n;den=d;
    }
    function iniciar(uint256 r0,uint256 r1) external{
        require(reserva0==0&&reserva1==0,"ja iniciou");
        reserva0=r0;reserva1=r1;
    }
    function getAmountOut(uint256 amount,address tokenIn) external view returns(uint256){
        require(tokenIn==token0||tokenIn==token1,"token");
        return amount*num/den;
    }
    function swap(uint256 out0,uint256 out1,address recipient,bytes calldata) external{
        uint256 a=ITokenAerotest(token0).balanceOf(address(this));
        uint256 b=ITokenAerotest(token1).balanceOf(address(this));
        require(a>=reserva0&&b>=reserva1,"reserve");
        uint256 input=out0>0?b-reserva1:a-reserva0;
        require((out0==0)!=(out1==0),"saida");
        require(out0+out1<=input*num/den,"pool out");
        if(out0>0)require(ITokenAerotest(token0).transfer(recipient,out0),"transfer0");
        if(out1>0)require(ITokenAerotest(token1).transfer(recipient,out1),"transfer1");
        reserva0=ITokenAerotest(token0).balanceOf(address(this));
        reserva1=ITokenAerotest(token1).balanceOf(address(this));
    }
}
