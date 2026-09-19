// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * CacadorDeLiquidacoes - liquida uma posicao da Aave com dinheiro emprestado
 * da propria Aave, dentro de uma transacao so.
 *
 * O CICLO, em uma frase:
 * pega emprestada a divida -> paga a divida do devedor -> recebe a garantia com
 * agio -> vende a garantia -> devolve o emprestimo -> guarda a sobra.
 *
 * POR QUE A CARTEIRA NUNCA PRECISA TER O DINHEIRO:
 * Uma liquidacao de US$200 mil exige pagar US$200 mil. O flash loan resolve
 * isso: a Aave entrega o valor, este contrato o usa e devolve antes de a
 * transacao terminar. Se qualquer passo falhar, TUDO e desfeito e ninguem
 * deve nada. A perda maxima e o gas.
 *
 * PARA ONDE VAI O LUCRO - e por que isso e imutavel:
 * `cofre` e gravado na criacao e nao tem funcao que o altere. A chave privada
 * deste contrato vive num servidor, e servidor e coisa que se invade. Se
 * alguem roubar a chave, o que consegue e queimar gas: nao consegue desviar o
 * lucro, porque o destino nao e parametro, e constante. Foi decisao dela,
 * registrada antes de existir dinheiro em jogo.
 *
 * O QUE ESTE CONTRATO NAO FAZ:
 * Nao escolhe a vitima nem decide se vale a pena. Ele executa a liquidacao que
 * for passada. Achar a posicao, medir o bonus e decidir se o gas compensa e
 * trabalho do vigia, que roda fora da cadeia e nao paga gas para pensar.
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

/**
 * O pool que sabe responder sozinho quanto sai.
 *
 * Pools no estilo Solidly (Aerodrome e parentes) expoem esta funcao. Quem a
 * responde dispensa que este contrato calcule qualquer coisa: a taxa, seja ela
 * qual for, e a curva, seja produto constante ou a curva de par estavel, ja
 * estao embutidas na resposta.
 *
 * Isso importa porque a taxa aqui estava escrita a mao como 0,3%. Na Aerodrome
 * a taxa e configurada por pool, e um pool "stable" nem usa produto constante.
 * Calcular por fora com numero errado nao erra o lucro: erra a conta que o
 * proprio pool confere, e a troca reverte.
 */
interface IPoolQueCalcula {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

contract CacadorDeLiquidacoes {
    address public immutable dono;
    address public immutable pool;

    /**
     * Para onde o lucro vai. Gravado na criacao, sem funcao que altere.
     *
     * Nao e zelo excessivo: a carteira quente guarda so o gas justamente
     * porque a chave dela fica exposta. Se o destino do lucro fosse
     * parametro, quem roubasse a chave apontaria para si mesmo e o teto de
     * seguranca nao existiria.
     */
    address public immutable cofre;

    /**
     * Trava de reentrada e de autorizacao ao mesmo tempo.
     *
     * So vale diferente de zero DENTRO de uma cacada iniciada por este
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
     * Saida de um swap Uniswap V2, com a taxa de 0,3% embutida.
     *
     * Reimplementada em vez de chamada do router: uma chamada externa a mais
     * custa gas em aritmetica pura, e aqui o gas decide se sobra lucro.
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
     * Dispara a cacada.
     *
     * @param garantia     token que se LEVA como premio
     * @param divida       token da divida que se PAGA (e que e emprestado)
     * @param devedor      quem quebrou
     * @param quantoCobrir quanto da divida cobrir, em unidades cruas
     * @param poolDeVenda  pool V2 onde a garantia vira divida de volta;
     *                     endereco zero quando garantia e divida sao o mesmo
     *                     token e nao ha o que trocar
     * @param lucroMinimo  piso; abaixo disso a transacao reverte inteira
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

    /**
     * Vende a garantia recebida e devolve quanto saiu de la.
     *
     * Antes de calcular, PERGUNTA. Um pool no estilo Solidly responde
     * `getAmountOut` e ja embute a taxa dele e a curva dele; um pool V2 nao
     * tem essa funcao, e nao ter e um fato sobre o pool, nao um erro. Por isso
     * a deteccao e uma chamada que pode falhar sem consequencia, e nao um
     * parametro que quem chama poderia errar.
     *
     * A ordem importa: perguntar primeiro e cair na conta so quando ninguem
     * responde deixa o caminho V2 - o unico que ja estava testado contra uma
     * EVM de verdade - exatamente como estava.
     *
     * O motivo de existir: o melhor pool V2 da Base tem US$649 mil, e o melhor
     * Aerodrome tem US$4,4 milhoes. Seis virgula oito vezes mais fundo e, na
     * conta medida, US$300 de lucro maximo por cacada contra US$2.103.
     */
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

        // Zero sai de pool vazio e de resposta sem sentido. Seguir com zero
        // entregaria a garantia e receberia nada - e o piso so confere depois.
        if (recebido == 0) revert PoolSemLiquidez();

        // O pool nao puxa fundos: quem entrega e o chamador.
        IERC20(garantia).transfer(poolDeVenda, quanto);
        if (ehToken0) {
            venda.swap(0, recebido, address(this), new bytes(0));
        } else {
            venda.swap(recebido, 0, address(this), new bytes(0));
        }
    }

    /**
     * Chamado pela Aave com o dinheiro ja em maos, antes de exigir a volta.
     * E aqui que a cacada inteira acontece.
     */
    function executeOperation(
        address ativo,
        uint256 quantia,
        uint256 premio,
        address iniciador,
        bytes calldata dados
    ) external returns (bool) {
        // Tres guardas, e as tres fazem trabalho diferente. A primeira impede
        // que qualquer endereco invoque isto. A segunda impede que a Aave
        // legitima, chamada por OUTRA pessoa, arraste este contrato para uma
        // execucao que ele nao comecou. A terceira fecha a janela fora de uma
        // cacada nossa.
        if (msg.sender != pool) revert ChamadaInesperada();
        if (iniciador != address(this)) revert ChamadaInesperada();
        if (!emCacada) revert ChamadaInesperada();

        (address garantia, address devedor, address poolDeVenda, uint256 lucroMinimo) =
            abi.decode(dados, (address, address, address, uint256));

        // Pagar a divida do devedor e receber a garantia com agio.
        IERC20(ativo).approve(pool, quantia);
        IPoolAave(pool).liquidationCall(garantia, ativo, devedor, quantia, false);

        // `balanceOf` em vez do valor calculado fora da cadeia: a Aave pode ter
        // cortado o valor coberto no limite dela, e agir sobre um numero que
        // ficou velho e errar por conta propria dentro de uma transacao que
        // ainda dava certo.
        if (poolDeVenda != address(0)) {
            _venderGarantia(garantia, poolDeVenda, IERC20(garantia).balanceOf(address(this)));
        }

        uint256 aDevolver = quantia + premio;
        uint256 emCaixa = IERC20(ativo).balanceOf(address(this));

        // A GARANTIA DE SEGURANCA. Conferir aqui, dentro da transacao, e o que
        // torna a estimativa do vigia irrelevante para o risco: ela pode estar
        // errada, e o pior caso continua sendo o gas.
        uint256 lucro = emCaixa > aDevolver ? emCaixa - aDevolver : 0;
        if (lucro < lucroMinimo) revert LucroInsuficiente(lucro, lucroMinimo);

        // A Aave PUXA o que e dela; a este contrato cabe autorizar.
        IERC20(ativo).approve(pool, aDevolver);

        if (lucro > 0) IERC20(ativo).transfer(cofre, lucro);
        emit Cacada(devedor, garantia, lucro);
        return true;
    }

    /**
     * Retirada de emergencia - para o cofre, nunca para quem chamou.
     *
     * Existe porque token pode sobrar aqui por caminho que ninguem previu, e
     * dinheiro preso em contrato e dinheiro perdido. Mandar para o cofre e nao
     * para `msg.sender` mantem a promessa: mesmo com a chave roubada, o que se
     * consegue e mover o lucro para o destino certo.
     */
    function resgatar(address token) external apenasDono {
        IERC20(token).transfer(cofre, IERC20(token).balanceOf(address(this)));
    }
}
