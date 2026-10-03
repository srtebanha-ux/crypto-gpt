// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPoolAave {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IPoolQueCalcula {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

contract CacadorDeLiquidacoes {
    address public immutable dono;
    address public immutable pool;
    address public immutable cofre;

    /**
     * Trava de reentrada otimizada para Gás.
     * Na EVM, mudar de 0 (false) para 1 (true) custa 20.000 de gás.
     * Mudar de 1 para 2 custa apenas 2.900 de gás.
     */
    uint256 private emCacada = 1;

    error NaoAutorizado();
    error ChamadaInesperada();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);
    error PoolSemLiquidez();
    error CofreInvalido();

    event Cacada(address indexed devedor, address garantia, uint256 lucro);

    constructor(address _pool, address _cofre) {
        if (_cofre == address(0) || _pool == address(0)) revert CofreInvalido();
        dono = msg.sender;
        pool = _pool;
        cofre = _cofre;
    }

    modifier apenasDono() {
        if (msg.sender != dono) revert NaoAutorizado();
        _;
    }

    /**
     * Proteção contra o Bug do USDT.
     * Tokens antigos revertem se tentarmos mudar um valor de approve existente
     * que não seja zero. Esta função zera a aprovação antes de aplicar a nova.
     */
    function _safeApprove(address token, address spender, uint256 amount) internal {
        IERC20(token).approve(spender, 0);
        IERC20(token).approve(spender, amount);
    }

    function _saidaDoSwap(uint256 entrada, uint256 reservaEntrada, uint256 reservaSaida)
        internal
        pure
        returns (uint256)
    {
        if (reservaEntrada == 0 || reservaSaida == 0) revert PoolSemLiquidez();
        uint256 comTaxa = entrada * 997;
        return (comTaxa * reservaSaida) / (reservaEntrada * 1000 + comTaxa);
    }

    function cacar(
        address garantia,
        address divida,
        address devedor,
        uint256 quantoCobrir,
        address poolDeVenda,
        uint256 lucroMinimo
    ) external apenasDono {
        emCacada = 2; // Trava ativada
        IPoolAave(pool).flashLoanSimple(
            address(this),
            divida,
            quantoCobrir,
            abi.encode(garantia, devedor, poolDeVenda, lucroMinimo),
            0
        );
        emCacada = 1; // Trava liberada
    }

    function _venderGarantia(address garantia, address poolDeVenda, uint256 quanto)
        internal
        returns (uint256 recebido)
    {
        IUniswapV2Pair venda = IUniswapV2Pair(poolDeVenda);
        bool ehToken0 = garantia == venda.token0();

        (bool respondeu, bytes memory resposta) = poolDeVenda.staticcall(
            abi.encodeWithSelector(IPoolQueCalcula.getAmountOut.selector, quanto, garantia)
        );

        if (respondeu && resposta.length == 32) {
            recebido = abi.decode(resposta, (uint256));
        } else {
            (uint112 r0, uint112 r1, ) = venda.getReserves();
            recebido = ehToken0
                ? _saidaDoSwap(quanto, uint256(r0), uint256(r1))
                : _saidaDoSwap(quanto, uint256(r1), uint256(r0));
        }

        if (recebido == 0) revert PoolSemLiquidez();

        IERC20(garantia).transfer(poolDeVenda, quanto);
        if (ehToken0) {
            venda.swap(0, recebido, address(this), new bytes(0));
        } else {
            venda.swap(recebido, 0, address(this), new bytes(0));
        }
    }

    function executeOperation(
        address ativo,
        uint256 quantia,
        uint256 premio,
        address iniciador,
        bytes calldata dados
    ) external returns (bool) {
        if (msg.sender != pool) revert ChamadaInesperada();
        if (iniciador != address(this)) revert ChamadaInesperada();
        if (emCacada != 2) revert ChamadaInesperada(); // Verificação atualizada

        (address garantia, address devedor, address poolDeVenda, uint256 lucroMinimo) =
            abi.decode(dados, (address, address, address, uint256));

        // Pagar dívida (usando safeApprove) e liquidar
        _safeApprove(ativo, pool, quantia);
        IPoolAave(pool).liquidationCall(garantia, ativo, devedor, quantia, false);

        if (poolDeVenda != address(0)) {
            _venderGarantia(garantia, poolDeVenda, IERC20(garantia).balanceOf(address(this)));
        }

        uint256 aDevolver = quantia + premio;
        uint256 emCaixa = IERC20(ativo).balanceOf(address(this));

        uint256 lucro = emCaixa > aDevolver ? emCaixa - aDevolver : 0;
        if (lucro < lucroMinimo) revert LucroInsuficiente(lucro, lucroMinimo);

        // Autorizar a Aave a puxar o Flash Loan de volta (usando safeApprove)
        _safeApprove(ativo, pool, aDevolver);

        if (lucro > 0) IERC20(ativo).transfer(cofre, lucro);
        emit Cacada(devedor, garantia, lucro);
        return true;
    }

    function resgatar(address token) external apenasDono {
        IERC20(token).transfer(cofre, IERC20(token).balanceOf(address(this)));
    }
}
