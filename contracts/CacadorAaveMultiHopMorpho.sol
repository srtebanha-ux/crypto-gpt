// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * TITAN: liquidacao Aave V3 financiada por Morpho FlashLoan (0 fee),
 * conversao do colateral por 1-4 swaps V3 / Aerodrome volatile.
 *
 * NOVO executor ISOLADO: nao substituir CacadorV3 atual nem usar chaves
 * em producao ate demonstrar gas/precificacao com ativos da Base real.
 *
 * Gatilhos: soDono, HF<1, fabrica V3 canonica, Aerodrome em allowlist,
 * contexto callback de Morpho e V3, baseline dos tokens, lucro minimo
 * em token da divida e pagamento integral do emprestimo.
 */
interface ITitanMultiERC {
    function balanceOf(address) external view returns(uint256);
    function approve(address,uint256) external returns(bool);
    function transfer(address,uint256) external returns(bool);
}
interface ITitanMultiAave {
    function getUserAccountData(address) external view returns(
        uint256,uint256,uint256,uint256,uint256,uint256
    );
    function liquidationCall(address,address,address,uint256,bool) external;
}
interface ITitanMultiMorpho {
    function flashLoan(address,uint256,bytes calldata) external;
}
interface ITitanMultiPool {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function swap(address,bool,int256,uint160,bytes calldata)
        external returns(int256,int256);
}
interface ITitanMultiFactory {
    function getPool(address,address,uint24) external view returns(address);
}
interface ITitanSlipstreamFactory {
    function getPool(address,address,int24) external view returns(address);
}
interface ITitanMultiAero {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function getAmountOut(uint256,address) external view returns(uint256);
    function swap(uint256,uint256,address,bytes calldata) external;
}
contract CacadorAaveMultiHopMorpho {
    address public immutable dono;
    address public immutable cofre;
    address public immutable aave;
    address public immutable morpho;
    address public immutable fabricaV3;
    address public constant slipstreamFactory = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address public constant slipstreamEurcUsdc = 0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7;
    address public constant eurcBase = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address public constant usdcBase = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint160 internal constant MIN_SQRT=4295128739+1;
    uint160 internal constant MAX_SQRT=1461446703485210103287273052203988822378723970342-1;

    struct Perna {
        address pool;
        address tokenEntra;
        uint8 tipo; // 0=Uniswap V3, 1=Aerodrome volatile, 2=Slipstream EURC/USDC
        uint24 fee; // Uniswap fee, Aero V2 zero, Slipstream tickSpacing
    }
    struct Caca {
        address usuario;
        address garantia;
        address divida;
        uint256 cobrir;
        uint256 piso;
        uint256 saldoDividaInicial;
        uint256 lucro;
        bool ativa;
        bool callbackAtivo;
    }
    Caca private caca;
    Perna[] private percurso;
    mapping(address=>uint256) private inicial;
    mapping(address=>bool) public aeroPermitida;
    address private poolEsperado;
    error NaoDono();
    error RotaInvalida();
    error AaveNaoLiquidavel();
    error CallbackInvalido();
    error SaldoCurto(address token,uint256 disponivel,uint256 devido);
    error SemLucro(uint256 lucro,uint256 piso);
    error TransferenciaFalhou(address token);
    event LiquidouComRota(address indexed usuario,address indexed origem,
        address indexed destino,uint256 quantia,uint256 lucro);
    event PoolAeroAutorizada(address indexed pool,bool habilitada);
    constructor(address cofre_,address aave_,address morpho_,address fabrica_) {
        require(cofre_!=address(0)&&aave_!=address(0)&&morpho_!=address(0)
            &&fabrica_!=address(0),"zero");
        dono=msg.sender;cofre=cofre_;aave=aave_;morpho=morpho_;fabricaV3=fabrica_;
    }
    modifier soDono(){if(msg.sender!=dono)revert NaoDono();_;}
    function autorizarPoolAero(address pool,bool habilitada) external soDono {
        if(pool==address(0)||caca.ativa)revert RotaInvalida();
        aeroPermitida[pool]=habilitada;
        emit PoolAeroAutorizada(pool,habilitada);
    }
    function _saldo(address token) internal view returns(uint256){
        return ITitanMultiERC(token).balanceOf(address(this));
    }
    function _livre(address token) internal view returns(uint256){
        uint256 a=_saldo(token);uint256 b=inicial[token];
        return a>b?a-b:0;
    }
    function _transferir(address token,address to,uint256 amount) internal {
        if(amount>0&&!ITitanMultiERC(token).transfer(to,amount))
            revert TransferenciaFalhou(token);
    }
    function _aprovar(address token,address to,uint256 amount) internal {
        if(!ITitanMultiERC(token).approve(to,0)
            ||!ITitanMultiERC(token).approve(to,amount))
            revert TransferenciaFalhou(token);
    }
    function _outro(address pool,address entrada) internal view returns(address){
        address a=ITitanMultiPool(pool).token0();
        address b=ITitanMultiPool(pool).token1();
        if(a==entrada)return b;
        if(b==entrada)return a;
        revert RotaInvalida();
    }
    function liquidar(
        address usuario,address garantia,address divida,uint256 cobrir,
        uint256 lucroMinimo,Perna[] calldata rota
    ) external soDono returns(uint256 lucro) {
        if(caca.ativa||usuario==address(0)||garantia==address(0)
            ||divida==address(0)||cobrir==0||lucroMinimo==0
            ||rota.length<1||rota.length>4)revert RotaInvalida();
        address proxima=garantia;
        for(uint256 i=0;i<rota.length;i++){
            Perna calldata p=rota[i];
            if(p.pool==address(0)||p.tokenEntra!=proxima)revert RotaInvalida();
            address saida=_outro(p.pool,p.tokenEntra);
            if(p.tipo==0){
                if(ITitanMultiFactory(fabricaV3).getPool(p.tokenEntra,saida,p.fee)
                    !=p.pool)revert RotaInvalida();
            }else if(p.tipo==1){
                if(!aeroPermitida[p.pool]||p.fee!=0)revert RotaInvalida();
            }else if(p.tipo==2){
                // Pair, factory and tick spacing are fixed onchain.
                if(p.pool!=slipstreamEurcUsdc||p.fee!=50
                    ||(p.tokenEntra!=eurcBase&&p.tokenEntra!=usdcBase)
                    ||ITitanSlipstreamFactory(slipstreamFactory)
                        .getPool(eurcBase,usdcBase,int24(uint24(p.fee)))!=p.pool)
                    revert RotaInvalida();
            }else revert RotaInvalida();
            proxima=saida;
        }
        if(proxima!=divida)revert RotaInvalida();
        (,,,,,uint256 hf)=ITitanMultiAave(aave).getUserAccountData(usuario);
        if(hf>=1e18)revert AaveNaoLiquidavel();

        delete percurso;
        for(uint256 i=0;i<rota.length;i++){
            percurso.push(rota[i]);
            inicial[rota[i].tokenEntra]=_saldo(rota[i].tokenEntra);
        }
        inicial[divida]=_saldo(divida);
        caca=Caca({usuario:usuario,garantia:garantia,divida:divida,
            cobrir:cobrir,piso:lucroMinimo,saldoDividaInicial:_saldo(divida),
            lucro:0,ativa:true,callbackAtivo:false});
        ITitanMultiMorpho(morpho).flashLoan(divida,cobrir,"");
        lucro=caca.lucro;
        // Agora o principal ja foi retirado pelo Morpho, nao pelo nosso
        // codigo. NENHUM saldo anterior conta como receita.
        if(_saldo(divida)<caca.saldoDividaInicial+lucro)revert RotaInvalida();
        for(uint256 i=0;i<rota.length;i++)delete inicial[rota[i].tokenEntra];
        delete inicial[divida];
        delete percurso;
        delete caca;
        _transferir(divida,cofre,lucro);
        emit LiquidouComRota(usuario,rota[0].pool,rota[rota.length-1].pool,cobrir,lucro);
    }
    function onMorphoFlashLoan(uint256 amount,bytes calldata) external {
        Caca storage c=caca;
        if(msg.sender!=morpho||!c.ativa||c.callbackAtivo||amount!=c.cobrir)
            revert CallbackInvalido();
        c.callbackAtivo=true;
        if(_livre(c.divida)<amount)revert SaldoCurto(c.divida,_livre(c.divida),amount);
        _aprovar(c.divida,aave,amount);
        ITitanMultiAave(aave).liquidationCall(
            c.garantia,c.divida,c.usuario,amount,false
        );
        for(uint256 i=0;i<percurso.length;i++){
            Perna memory p=percurso[i];
            uint256 valor=_livre(p.tokenEntra);
            if(valor==0||valor>uint256(type(int256).max))
                revert SaldoCurto(p.tokenEntra,valor,1);
            if(p.tipo==0||p.tipo==2){
                bool z=ITitanMultiPool(p.pool).token0()==p.tokenEntra;
                poolEsperado=p.pool;
                ITitanMultiPool(p.pool).swap(address(this),z,int256(valor),
                    z?MIN_SQRT:MAX_SQRT,abi.encode(i));
                poolEsperado=address(0);
            }else{
                uint256 saida=ITitanMultiAero(p.pool).getAmountOut(valor,p.tokenEntra);
                if(saida==0)revert SaldoCurto(p.tokenEntra,valor,1);
                bool z=ITitanMultiPool(p.pool).token0()==p.tokenEntra;
                _transferir(p.tokenEntra,p.pool,valor);
                ITitanMultiAero(p.pool).swap(z?0:saida,z?saida:0,address(this),"");
            }
        }
        uint256 atual=_saldo(c.divida);
        uint256 necessario=c.saldoDividaInicial+amount+c.piso;
        if(atual<necessario)
            revert SemLucro(
                atual>c.saldoDividaInicial+amount
                    ?atual-c.saldoDividaInicial-amount:0,c.piso
            );
        c.lucro=atual-c.saldoDividaInicial-amount;
        _aprovar(c.divida,morpho,amount);
        c.callbackAtivo=false;
    }
    function uniswapV3SwapCallback(int256 d0,int256 d1,bytes calldata) external{
        _pagarV3(d0,d1);
    }
    function algebraSwapCallback(int256 d0,int256 d1,bytes calldata) external{
        _pagarV3(d0,d1);
    }
    function _pagarV3(int256 d0,int256 d1) internal{
        if(!caca.ativa||!caca.callbackAtivo||msg.sender!=poolEsperado
            ||poolEsperado==address(0)||(d0<=0&&d1<=0)||(d0>0&&d1>0))
            revert CallbackInvalido();
        address token=d0>0?ITitanMultiPool(msg.sender).token0():
            ITitanMultiPool(msg.sender).token1();
        uint256 deve=d0>0?uint256(d0):uint256(d1);
        uint256 tem=_livre(token);
        if(tem<deve)revert SaldoCurto(token,tem,deve);
        _transferir(token,msg.sender,deve);
    }
    function resgatar(address token) external soDono{
        if(caca.ativa)revert RotaInvalida();
        _transferir(token,cofre,_saldo(token));
    }
}
