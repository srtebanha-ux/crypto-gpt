// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * TITAN: fonte alternativa de capital via flashLoan do Morpho Blue.
 * O CacadorV3 existente permanece intacto. Este contrato NAO esta implantado.
 * Nao usa Aave e o Morpho cobra ZERO de fee sobre o principal.
 * So aceita 2-4 swaps atomicos, pool V3 (0) ou Aerodrome volatile (1).
 */
interface IMorphoFonte { function flashLoan(address token,uint256 assets,bytes calldata data) external; }
interface IERC20Fonte {
    function balanceOf(address) external view returns(uint256);
    function transfer(address,uint256) external returns(bool);
    function approve(address,uint256) external returns(bool);
}
interface IPoolFonte {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
}
interface IAeroFonte {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function getAmountOut(uint256,address) external view returns(uint256);
    function swap(uint256,uint256,address,bytes calldata) external;
}
contract CacadorArbMorpho {
    address public immutable dono;
    address public immutable cofre;
    address public immutable morpho;
    uint160 constant MIN_SQRT=4295128739;
    uint160 constant MAX_SQRT=1461446703485210103287273052203988822378723970342;
    struct Perna { address pool; address tokenEntra; uint8 tipo; uint256 pagamento; }
    Perna[] private rota;
    mapping(address=>uint256) private antes;
    bool private ativo;
    bool private callbackAtivo;
    address private poolEsperado;
    address private tokenBase;
    uint256 private principal;
    uint256 private piso;
    uint256 private saldoBaseInicial;
    uint256 private lucroCiclo;
    error NaoDono();
    error Bloqueado();
    error RotaInvalida();
    error CallbackInvalido();
    error TransferenciaFalhou(address token);
    error EntradaInsuficiente(uint256 saldo,uint256 devido);
    error LucroInsuficiente(uint256 lucro,uint256 piso);
    event CacouMorpho(address indexed poolA,address indexed poolB,uint256 lucro);

    constructor(address cofre_,address morpho_) {
        require(cofre_!=address(0) && morpho_!=address(0),"endereco zero");
        dono=msg.sender; cofre=cofre_; morpho=morpho_;
    }
    modifier soDono() { if(msg.sender!=dono) revert NaoDono(); _; }
    function _saldo(address t) private view returns(uint256) {
        return IERC20Fonte(t).balanceOf(address(this));
    }
    function _livre(address t) private view returns(uint256) {
        uint256 a=_saldo(t); uint256 b=antes[t]; return a>b?a-b:0;
    }
    function _transferir(address t,address para,uint256 q) private {
        if(q!=0 && !IERC20Fonte(t).transfer(para,q)) revert TransferenciaFalhou(t);
    }
    function _outro(address pool,address entra) private view returns(address) {
        address a=IPoolFonte(pool).token0();
        address b=IPoolFonte(pool).token1();
        if(entra==a) return b;
        if(entra==b) return a;
        revert RotaInvalida();
    }
    function executarRota(Perna[] calldata pernas,uint256 quantia,uint256 lucroMinimo)
        external soDono returns(uint256 lucro) {
        if(ativo) revert Bloqueado();
        if(quantia==0 || quantia>uint256(type(int256).max) ||
            pernas.length<2 || pernas.length>4) revert RotaInvalida();
        address base=pernas[0].tokenEntra;
        if(base==address(0)) revert RotaInvalida();
        for(uint256 i=0;i<pernas.length;i++) {
            Perna calldata p=pernas[i];
            if(p.pool==address(0) || p.tipo>1 || p.tokenEntra==address(0))
                revert RotaInvalida();
            address proximo=i+1<pernas.length?pernas[i+1].tokenEntra:base;
            if(_outro(p.pool,p.tokenEntra)!=proximo) revert RotaInvalida();
        }
        delete rota;
        for(uint256 i=0;i<pernas.length;i++) {
            rota.push(pernas[i]);
            antes[pernas[i].tokenEntra]=_saldo(pernas[i].tokenEntra);
        }
        ativo=true; tokenBase=base; principal=quantia; piso=lucroMinimo;
        saldoBaseInicial=_saldo(base);
        IMorphoFonte(morpho).flashLoan(base,quantia,"");
        // Morpho ja puxou o principal por transferFrom ao retornar do callback.
        lucro=lucroCiclo;
        if(_saldo(base)<saldoBaseInicial+lucro) revert Bloqueado();
        for(uint256 i=0;i<pernas.length;i++) delete antes[pernas[i].tokenEntra];
        delete rota;
        delete tokenBase; delete principal; delete piso;
        delete saldoBaseInicial; delete lucroCiclo;
        ativo=false;
        _transferir(base,cofre,lucro);
        emit CacouMorpho(pernas[0].pool,pernas[pernas.length-1].pool,lucro);
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata) external {
        if(msg.sender!=morpho || !ativo || callbackAtivo || assets!=principal)
            revert CallbackInvalido();
        callbackAtivo=true;
        if(_livre(tokenBase)<assets) revert EntradaInsuficiente(_livre(tokenBase),assets);
        for(uint256 i=0;i<rota.length;i++) {
            Perna memory p=rota[i];
            uint256 livre=_livre(p.tokenEntra);
            if(livre==0) revert EntradaInsuficiente(0,1);
            if(p.tipo==0) {
                bool z=IPoolFonte(p.pool).token0()==p.tokenEntra;
                poolEsperado=p.pool;
                IPoolFonte(p.pool).swap(address(this),z,int256(livre),
                    z?MIN_SQRT+1:MAX_SQRT-1,abi.encode(i));
                poolEsperado=address(0);
            } else if(p.tipo==1) {
                uint256 paga=p.pagamento==0?livre:p.pagamento;
                if(paga==0 || paga>livre) revert EntradaInsuficiente(livre,paga);
                uint256 sai=IAeroFonte(p.pool).getAmountOut(paga,p.tokenEntra);
                if(sai==0) revert EntradaInsuficiente(0,1);
                bool in0=IAeroFonte(p.pool).token0()==p.tokenEntra;
                _transferir(p.tokenEntra,p.pool,paga);
                IAeroFonte(p.pool).swap(in0?0:sai,in0?sai:0,address(this),"");
            } else revert RotaInvalida();
        }
        uint256 finalBase=_saldo(tokenBase);
        if(finalBase<saldoBaseInicial+principal) revert LucroInsuficiente(0,piso);
        uint256 lucro=finalBase-saldoBaseInicial-principal;
        if(lucro<piso) revert LucroInsuficiente(lucro,piso);
        lucroCiclo=lucro;
        // Morpho coleta o principal apos este callback. Nao envia ao cofre antes.
        if(!IERC20Fonte(tokenBase).approve(morpho,0) ||
           !IERC20Fonte(tokenBase).approve(morpho,principal))
            revert TransferenciaFalhou(tokenBase);
        callbackAtivo=false;
    }
    function uniswapV3SwapCallback(int256 a,int256 b,bytes calldata) external {
        _pagarV3(a,b);
    }
    function algebraSwapCallback(int256 a,int256 b,bytes calldata) external {
        _pagarV3(a,b);
    }
    function _pagarV3(int256 a,int256 b) private {
        if(!ativo || !callbackAtivo || msg.sender!=poolEsperado || poolEsperado==address(0))
            revert CallbackInvalido();
        if((a<=0 && b<=0) || (a>0 && b>0)) revert CallbackInvalido();
        address token=a>0?IPoolFonte(msg.sender).token0():IPoolFonte(msg.sender).token1();
        uint256 devido=a>0?uint256(a):uint256(b);
        uint256 livre=_livre(token);
        if(livre<devido) revert EntradaInsuficiente(livre,devido);
        _transferir(token,msg.sender,devido);
    }
}