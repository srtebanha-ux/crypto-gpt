// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/** Exclusively local Aave V3 + exact-output V3 doubles for integration tests. */
interface ITitanAaveTestToken {
    function balanceOf(address) external view returns(uint256);
    function transfer(address,uint256) external returns(bool);
    function transferFrom(address,address,uint256) external returns(bool);
}
interface ITitanAaveCallback {
    function uniswapV3SwapCallback(int256,int256,bytes calldata) external;
}
contract TitanAaveTestPool {
    uint256 public hf=0.98e18;
    uint256 public bonusNum=105;
    uint256 public bonusDen=100;
    bool public liquidateEnabled=true;
    function configure(uint256 hf_,uint256 num_,uint256 den_,bool enabled_) external {
        hf=hf_;bonusNum=num_;bonusDen=den_;liquidateEnabled=enabled_;
    }
    function getUserAccountData(address) external view returns (
        uint256,uint256,uint256,uint256,uint256,uint256
    ) { return (100,99,1,8000,7500,hf); }
    function liquidationCall(
        address collateral,address debt,address,uint256 cover,bool
    ) external {
        require(liquidateEnabled && hf<1e18,"healthy or closed");
        require(ITitanAaveTestToken(debt).transferFrom(msg.sender,address(this),cover),"debt transfer");
        require(ITitanAaveTestToken(collateral).transfer(msg.sender,
            cover*bonusNum/bonusDen),"collateral out");
    }
}
contract TitanV3FactoryTest {
    mapping(bytes32=>address) private pools;
    function registrar(address a,address b,uint24 fee,address pool) external {
        pools[keccak256(abi.encode(a,b,fee))]=pool;
        pools[keccak256(abi.encode(b,a,fee))]=pool;
    }
    function getPool(address a,address b,uint24 fee) external view returns(address) {
        return pools[keccak256(abi.encode(a,b,fee))];
    }
}
contract TitanV3SaidaExataTest {
    address public immutable token0;
    address public immutable token1;
    uint256 public colateralDevidoBps=10_200;
    bool public entregarTudo=true;
    constructor(address a,address b) { token0=a;token1=b; }
    function configurar(uint256 bps,bool completa) external {
        colateralDevidoBps=bps;entregarTudo=completa;
    }
    function swap(
        address recipient,bool zeroForOne,int256 amountSpecified,
        uint160,bytes calldata data
    ) external returns(int256,int256) {
        require(amountSpecified<0,"expected exact output");
        uint256 saida=uint256(-amountSpecified);
        if(!entregarTudo) saida=saida*90/100;
        address collateral=zeroForOne?token0:token1;
        address debt=zeroForOne?token1:token0;
        uint256 deve=(saida*colateralDevidoBps+9999)/10000;
        uint256 antes=ITitanAaveTestToken(collateral).balanceOf(address(this));
        require(ITitanAaveTestToken(debt).transfer(recipient,saida),"output");
        ITitanAaveCallback(msg.sender).uniswapV3SwapCallback(
            zeroForOne?int256(deve):-int256(saida),
            zeroForOne?-int256(saida):int256(deve),data
        );
        require(ITitanAaveTestToken(collateral).balanceOf(address(this))
            >=antes+deve,"pool underpaid");
        return (zeroForOne?int256(deve):-int256(saida),
            zeroForOne?-int256(saida):int256(deve));
    }
}
