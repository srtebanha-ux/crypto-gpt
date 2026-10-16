// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/** Exclusivo dos testes LOCAIS do executor Morpho: nenhum destes enderecos e Base. */
interface ICallbackTeste {
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external;
}
interface IV3CallbackTeste {
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata data) external;
}
contract TitanTokenTeste {
    string public symbol;
    uint8 public decimals=18;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    constructor(string memory symbol_) { symbol=symbol_; }
    function mint(address to,uint256 v) external { balanceOf[to]+=v; }
    function transfer(address to,uint256 v) external returns(bool) {
        require(balanceOf[msg.sender]>=v,"saldo");
        balanceOf[msg.sender]-=v;
        balanceOf[to]+=v;
        return true;
    }
    function approve(address spender,uint256 v) external returns(bool) {
        allowance[msg.sender][spender]=v;
        return true;
    }
    function transferFrom(address from,address to,uint256 v) external returns(bool) {
        require(balanceOf[from]>=v,"saldo");
        require(allowance[from][msg.sender]>=v,"allowance");
        allowance[from][msg.sender]-=v;
        balanceOf[from]-=v; balanceOf[to]+=v;
        return true;
    }
}
contract TitanMorphoTeste {
    function flashLoan(address token,uint256 assets,bytes calldata data) external {
        require(TitanTokenTeste(token).transfer(msg.sender,assets),"saida");
        ICallbackTeste(msg.sender).onMorphoFlashLoan(assets,data);
        require(TitanTokenTeste(token).transferFrom(msg.sender,address(this),assets),"retorno");
    }
}
contract TitanV3Teste {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable numerador;
    uint256 public immutable denominador;
    constructor(address a,address b,uint256 num,uint256 den) {
        token0=a;token1=b;numerador=num;denominador=den;
    }
    function swap(address recipient,bool z,int256 amountSpecified,uint160,bytes calldata data)
        external returns(int256,int256) {
        require(amountSpecified>0,"quantia positiva");
        uint256 entra=uint256(amountSpecified);
        uint256 sai=z? entra*numerador/denominador : entra*denominador/numerador;
        address input=z?token0:token1;
        address output=z?token1:token0;
        uint256 antes=TitanTokenTeste(input).balanceOf(address(this));
        require(TitanTokenTeste(output).transfer(recipient,sai),"sem saida");
        IV3CallbackTeste(msg.sender).uniswapV3SwapCallback(
            z?int256(entra):-int256(sai),z?-int256(sai):int256(entra),data
        );
        require(TitanTokenTeste(input).balanceOf(address(this))>=antes+entra,"nao pagou pool");
        return (z?int256(entra):-int256(sai),z?-int256(sai):int256(entra));
    }
}
