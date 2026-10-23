// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/** SOMENTE PARA TESTE LOCAL. Nao representa endereco implantado na Base. */
interface IMorphoCacadaDoTeste {
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external;
}
interface ITokenCacadaDoTeste {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
struct ParametrosMorphoDoTeste {
    address loanToken; address collateralToken; address oracle; address irm; uint256 lltv;
}
/** Replica estritamente a ordem Morpho: SEIZURE -> CALLBACK -> REPAY. */
contract MorphoAuditoriaFalso {
    function liquidate(
        ParametrosMorphoDoTeste calldata params,
        address,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 assetsRepaid,uint256 sharesRepaid) {
        require((seizedAssets==0)!=(repaidShares==0),"one amount");
        uint256 repay=seizedAssets>0?seizedAssets:repaidShares;
        uint256 coll=(repay*110)/100;
        require(ITokenCacadaDoTeste(params.collateralToken).transfer(msg.sender,coll),"coll transfer");
        IMorphoCacadaDoTeste(msg.sender).onMorphoLiquidate(repay,data);
        require(ITokenCacadaDoTeste(params.loanToken).transferFrom(msg.sender,address(this),repay),"debt repay");
        return(repay,repay);
    }
}
/** Contrato que mente sobre transfer: nao reverte, mas devolve FALSE. */
contract ERC20RetornoFalsoTeste {
    mapping(address=>uint256) public balanceOf;
    function criar(address to,uint256 amount) external { balanceOf[to]+=amount; }
    function allowance(address,address) external pure returns(uint256){return 0;}
    function approve(address,uint256) external pure returns(bool){return false;}
    function transfer(address,uint256) external pure returns(bool){return false;}
    function transferFrom(address,address,uint256) external pure returns(bool){return false;}
}

/** Models interest-before-health ordering for admission regression, not mainnet economics. */
contract MorphoJurosFalso {
    uint256 public divida=100;
    uint256 public jurosPendentes=2;
    uint256 public limite=101;
    function configurar(uint256 juros) external {jurosPendentes=juros;}
    function liquidate(ParametrosMorphoDoTeste calldata params,address,
        uint256 seizedAssets,uint256 repaidShares,bytes calldata data
    ) external returns(uint256,uint256){
        require((seizedAssets==0)!=(repaidShares==0),"one amount");
        divida+=jurosPendentes;jurosPendentes=0; // accrual in SAME call
        require(divida>limite,"HEALTHY_POSITION");
        uint256 repay=seizedAssets>0?seizedAssets:repaidShares;
        require(ITokenCacadaDoTeste(params.collateralToken).transfer(msg.sender,repay*110/100));
        IMorphoCacadaDoTeste(msg.sender).onMorphoLiquidate(repay,data);
        require(ITokenCacadaDoTeste(params.loanToken).transferFrom(msg.sender,address(this),repay));
        return(repay,repay);
    }
}
