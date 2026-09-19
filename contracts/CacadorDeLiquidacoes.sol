// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * CacadorDeLiquidacoes — liquida uma posição da Aave com dinheiro emprestado
 * da própria Aave, dentro de uma transação só.
 *
 * O CICLO, em uma frase:
 * pega emprestada a dívida → paga a dívida do devedor → recebe a garantia com
 * ágio → vende a garantia → devolve o empréstimo → guarda a sobra.
 *
 * POR QUE A CARTEIRA NUNCA PRECISA TER O DINHEIRO:
 * Uma liquidação de US$200 mil exige pagar US$200 mil. O flash loan resolve
 * isso: a Aave entrega o valor, este contrato o usa e devolve antes de a
 * transação terminar. Se qualquer passo falhar, TUDO é desfeito e ninguém
 * deve nada. A perda máxima é o gás.
 *
 * PARA ONDE VAI O LUCRO — e por que isso é imutável:
 * `cofre` é gravado na criação e não tem função que o altere. A chave privada
 * deste contrato vive num servidor, e servidor é coisa que se invade. Se
 * alguém roubar a chave, o que consegue é queimar gás: não consegue desviar o
 * lucro, porque o destino não é parâmetro, é constante. Foi decisão dela,
 * registrada antes de existir dinheiro em jogo.
 *
 * O QUE ESTE CONTRATO NÃO FAZ:
 * Não escolhe a vítima nem decide se vale a pena. Ele executa a liquidação que
 * for passada. Achar a posição, medir o bônus e decidir se o gás compensa é
 * trabalho do vigia, que roda fora da cadeia e não paga gás para pensar.
 */

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

contract CacadorDeLiquidacoes {
    address public immutable dono;
    address public immutable pool;

    /**
     * Para onde o lucro vai. Gravado na criação, sem função que altere.
     *
     * Não é zelo excessivo: a carteira quente guarda só o gás justamente
     * porque a chave dela fica exposta. Se o destino do lucro fosse
     * parâmetro, quem roubasse a chave apontaria para si mesmo e o teto de
     * segurança não existiria.
     */
    address public immutable cofre;

    /**
     * Trava de reentrada e de autorização ao mesmo tempo.
     *
     * Só vale diferente de zero DENTRO de uma caçada iniciada por este
     * contrato. Sem ela, qualquer um chamaria `executeOperation` com dados
     * inventados e moveria o que estivesse aqui dentro.
     */
    bool private emCacada;

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
     * Saída de um swap Uniswap V2, com a taxa de 0,3% embutida.
     *
     * Reimplementada em vez de chamada do router: uma chamada externa a mais
     * custa gás em aritmética pura, e aqui o gás decide se sobra lucro.
     */
    function _saidaDoSwap(uint256 entrada, uint256 reservaEntrada, uint256 reservaSaida)
        internal
        pure
        returns (uint256)
    {
        if (reservaEntrada == 0 || reservaSaida == 0) revert PoolSemLiquidez();
        uint256 comTaxa = entrada * 997;
        return (comTaxa * reservaSaida) / (reservaEntrada * 1000 + comTaxa);
    }

    /**
     * Dispara a caçada.
     *
     * @param garantia     token que se LEVA como prêmio
     * @param divida       token da dívida que se PAGA (e que é emprestado)
     * @param devedor      quem quebrou
     * @param quantoCobrir quanto da dívida cobrir, em unidades cruas
     * @param poolDeVenda  pool V2 onde a garantia vira dívida de volta;
     *                     endereço zero quando garantia e dívida são o mesmo
     *                     token e não há o que trocar
     * @param lucroMinimo  piso; abaixo disso a transação reverte inteira
     */
    function cacar(
        address garantia,
        address divida,
        address devedor,
        uint256 quantoCobrir,
        address poolDeVenda,
        uint256 lucroMinimo
    ) external apenasDono {
        emCacada = true;
        IPoolAave(pool).flashLoanSimple(
            address(this),
            divida,
            quantoCobrir,
            abi.encode(garantia, devedor, poolDeVenda, lucroMinimo),
            0
        );
        emCacada = false;
    }

    /** Vende a garantia recebida e devolve quanto saiu de lá. */
    function _venderGarantia(address garantia, address poolDeVenda, uint256 quanto)
        internal
        returns (uint256 recebido)
    {
        IUniswapV2Pair venda = IUniswapV2Pair(poolDeVenda);
        bool ehToken0 = garantia == venda.token0();
        (uint112 r0, uint112 r1, ) = venda.getReserves();
        recebido = ehToken0
            ? _saidaDoSwap(quanto, uint256(r0), uint256(r1))
            : _saidaDoSwap(quanto, uint256(r1), uint256(r0));

        // O pool V2 não puxa fundos: quem entrega é o chamador.
        IERC20(garantia).transfer(poolDeVenda, quanto);
        if (ehToken0) {
            venda.swap(0, recebido, address(this), new bytes(0));
        } else {
            venda.swap(recebido, 0, address(this), new bytes(0));
        }
    }

    /**
     * Chamado pela Aave com o dinheiro já em mãos, antes de exigir a volta.
     * É aqui que a caçada inteira acontece.
     */
    function executeOperation(
        address ativo,
        uint256 quantia,
        uint256 premio,
        address iniciador,
        bytes calldata dados
    ) external returns (bool) {
        // Três guardas, e as três fazem trabalho diferente. A primeira impede
        // que qualquer endereço invoque isto. A segunda impede que a Aave
        // legítima, chamada por OUTRA pessoa, arraste este contrato para uma
        // execução que ele não começou. A terceira fecha a janela fora de uma
        // caçada nossa.
        if (msg.sender != pool) revert ChamadaInesperada();
        if (iniciador != address(this)) revert ChamadaInesperada();
        if (!emCacada) revert ChamadaInesperada();

        (address garantia, address devedor, address poolDeVenda, uint256 lucroMinimo) =
            abi.decode(dados, (address, address, address, uint256));

        // Pagar a dívida do devedor e receber a garantia com ágio.
        IERC20(ativo).approve(pool, quantia);
        IPoolAave(pool).liquidationCall(garantia, ativo, devedor, quantia, false);

        // `balanceOf` em vez do valor calculado fora da cadeia: a Aave pode ter
        // cortado o valor coberto no limite dela, e agir sobre um número que
        // ficou velho é errar por conta própria dentro de uma transação que
        // ainda dava certo.
        if (poolDeVenda != address(0)) {
            _venderGarantia(garantia, poolDeVenda, IERC20(garantia).balanceOf(address(this)));
        }

        uint256 aDevolver = quantia + premio;
        uint256 emCaixa = IERC20(ativo).balanceOf(address(this));

        // A GARANTIA DE SEGURANÇA. Conferir aqui, dentro da transação, é o que
        // torna a estimativa do vigia irrelevante para o risco: ela pode estar
        // errada, e o pior caso continua sendo o gás.
        uint256 lucro = emCaixa > aDevolver ? emCaixa - aDevolver : 0;
        if (lucro < lucroMinimo) revert LucroInsuficiente(lucro, lucroMinimo);

        // A Aave PUXA o que é dela; a este contrato cabe autorizar.
        IERC20(ativo).approve(pool, aDevolver);

        if (lucro > 0) IERC20(ativo).transfer(cofre, lucro);
        emit Cacada(devedor, garantia, lucro);
        return true;
    }

    /**
     * Retirada de emergência — para o cofre, nunca para quem chamou.
     *
     * Existe porque token pode sobrar aqui por caminho que ninguém previu, e
     * dinheiro preso em contrato é dinheiro perdido. Mandar para o cofre e não
     * para `msg.sender` mantém a promessa: mesmo com a chave roubada, o que se
     * consegue é mover o lucro para o destino certo.
     */
    function resgatar(address token) external apenasDono {
        IERC20(token).transfer(cofre, IERC20(token).balanceOf(address(this)));
    }
}
