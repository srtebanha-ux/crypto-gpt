// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Cacador de liquidacoes da Aave, com venda por roteador.
 *
 * O ciclo inteiro cabe numa transacao: pega emprestado sem garantia, paga a
 * divida de quem quebrou, leva o colateral com agio, vende o colateral,
 * devolve o emprestimo, e o que sobra vai para o cofre. Se qualquer passo
 * falhar, a rede desfaz tudo e o custo e so o gas.
 *
 * POR QUE A VENDA MUDOU
 *
 * A versao anterior vendia num pool so, e sabia calcular a taxa dele. Isso
 * travou o teto em US$57 mil de divida: o melhor pool V2 da Base tem
 * US$649 mil de profundidade, e vender US$134 mil ali empurra o preco 17%
 * contra um agio de 5%. Medido, nao suposto.
 *
 * Agora o contrato NAO sabe calcular nada de DEX. Quem monta a rota e o bot,
 * fora da cadeia, onde pode consultar um agregador que divide a venda entre
 * varios pools e varias versoes. O contrato so repassa o payload pronto.
 *
 * E O QUE ISSO CUSTARIA DE SEGURANCA, SE NAO FOSSE TRAVADO
 *
 * Uma chamada de baixo nivel para um endereco escolhido por quem invoca e uma
 * porta aberta: com a chave do bot roubada, o ladrao mandaria o contrato
 * chamar qualquer contrato com qualquer instrucao, inclusive transferir os
 * tokens para ele. Hoje uma chave roubada so queima gas, porque o cofre e
 * imutavel — e essa propriedade foi construida de proposito.
 *
 * Por isso `roteador` e IMUTAVEL, fixado no deploy. A rota continua sendo
 * calculada fora; so o DESTINO fica preso. Quem tem a chave escolhe o
 * caminho, nunca para onde o dinheiro vai.
 */

interface IERC20 {
    function balanceOf(address conta) external view returns (uint256);
    function transfer(address para, uint256 quantia) external returns (bool);
    function approve(address gastador, uint256 quantia) external returns (bool);
    function allowance(address dono, address gastador) external view returns (uint256);
}

interface IPoolAave {
    function flashLoanSimple(
        address receptor,
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

contract CacadorDeLiquidacoes {
    /** Quem pode mandar cacar. Fixado no deploy: e quem publicou. */
    address public immutable dono;

    /** A Aave desta rede: de onde vem o emprestimo e onde se liquida. */
    address public immutable pool;

    /**
     * Para onde o lucro vai. IMUTAVEL e sem funcao para trocar.
     *
     * E a defesa contra a chave do bot vazar: quem a roubar pode fazer o
     * contrato cacar, mas o lucro cai aqui de qualquer jeito. Ele nao tem
     * como redirecionar nada.
     */
    address public immutable cofre;

    /**
     * Para onde a venda do colateral e enviada. IMUTAVEL pelo mesmo motivo.
     *
     * Sem essa trava, `dadosSwap` viraria "execute qualquer coisa em qualquer
     * lugar" — o oposto exato do que o cofre imutavel garante.
     */
    address public immutable roteador;

    /** Trava de reentrada e de autorizacao ao mesmo tempo. */
    bool private emCacada;

    error NaoAutorizado();
    error ChamadaInesperada();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);
    error VendaFalhou(bytes motivo);
    error EnderecoInvalido();

    event Cacada(address indexed devedor, address garantia, uint256 lucro);

    constructor(address _pool, address _cofre, address _roteador) {
        if (_cofre == address(0) || _pool == address(0) || _roteador == address(0)) revert EnderecoInvalido();
        dono = msg.sender;
        pool = _pool;
        cofre = _cofre;
        roteador = _roteador;
    }

    modifier apenasDono() {
        if (msg.sender != dono) revert NaoAutorizado();
        _;
    }

    /**
     * Autoriza zerando antes, porque alguns tokens exigem isso.
     *
     * USDT e parentes revertem quando se troca uma autorizacao diferente de
     * zero por outra diferente de zero. O caminho antigo dava `approve` duas
     * vezes para a mesma pool na mesma transacao — na primeira moeda assim, a
     * cacada inteira reverteria, e o log diria apenas "revertida".
     *
     * Zerar sempre custa um punhado de gas e vale o seguro: e barato demais
     * para depender de saber quais moedas se comportam bem.
     */
    function _autorizar(address token, address gastador, uint256 quantia) internal {
        if (IERC20(token).allowance(address(this), gastador) != 0) {
            IERC20(token).approve(gastador, 0);
        }
        IERC20(token).approve(gastador, quantia);
    }

    /**
     * Dispara a cacada.
     *
     * @param garantia     token que se LEVA como premio
     * @param divida       token da divida que se PAGA (e que e emprestado)
     * @param devedor      quem quebrou
     * @param quantoCobrir quanto da divida cobrir, em unidades cruas
     * @param dadosSwap    payload pronto para o roteador; vazio quando garantia
     *                     e divida sao a mesma moeda e nao ha o que trocar
     * @param lucroMinimo  piso; abaixo disso a transacao reverte inteira
     */
    function cacar(
        address garantia,
        address divida,
        address devedor,
        uint256 quantoCobrir,
        bytes calldata dadosSwap,
        uint256 lucroMinimo
    ) external apenasDono {
        emCacada = true;
        IPoolAave(pool).flashLoanSimple(
            address(this),
            divida,
            quantoCobrir,
            abi.encode(garantia, devedor, dadosSwap, lucroMinimo),
            0
        );
        emCacada = false;
    }

    /**
     * Chamado pela Aave com o dinheiro em maos, antes de exigir a volta.
     *
     * As tres guardas fazem trabalhos diferentes: a primeira impede que
     * qualquer endereco invoque isto; a segunda impede que a Aave legitima,
     * chamada por OUTRA pessoa, arraste este contrato para uma execucao que
     * ele nao comecou; a terceira fecha a janela fora de uma cacada nossa.
     */
    function executeOperation(
        address ativo,
        uint256 quantia,
        uint256 premio,
        address iniciador,
        bytes calldata dados
    ) external returns (bool) {
        if (msg.sender != pool) revert ChamadaInesperada();
        if (iniciador != address(this)) revert ChamadaInesperada();
        if (!emCacada) revert ChamadaInesperada();

        (address garantia, address devedor, bytes memory dadosSwap, uint256 lucroMinimo) =
            abi.decode(dados, (address, address, bytes, uint256));

        // Pagar a divida do devedor e receber a garantia com agio.
        _autorizar(ativo, pool, quantia);
        IPoolAave(pool).liquidationCall(garantia, ativo, devedor, quantia, false);

        // Vender a garantia, quando ha o que vender. O contrato nao calcula
        // nada: autoriza o roteador a puxar, e repassa o payload que o bot
        // montou consultando o agregador fora da cadeia.
        if (garantia != ativo && dadosSwap.length > 0) {
            uint256 aVender = IERC20(garantia).balanceOf(address(this));
            _autorizar(garantia, roteador, aVender);
            (bool deu, bytes memory motivo) = roteador.call(dadosSwap);
            if (!deu) revert VendaFalhou(motivo);
            // Nao deixar autorizacao sobrando: o roteador so pode puxar
            // durante esta transacao.
            _autorizar(garantia, roteador, 0);
        }

        // `balanceOf` em vez do valor calculado fora da cadeia: a Aave pode ter
        // cortado o quanto cobrir, e o roteador pode ter devolvido mais ou
        // menos que o previsto. O que vale e o que esta na mao.
        uint256 aDevolver = quantia + premio;
        uint256 emCaixa = IERC20(ativo).balanceOf(address(this));
        uint256 lucro = emCaixa > aDevolver ? emCaixa - aDevolver : 0;

        // A trava intocada: se a rota calculada fora sofreu deslizamento e o
        // lucro ficou abaixo do piso, a transacao inteira se desfaz e o custo
        // e so o gas.
        if (lucro < lucroMinimo) revert LucroInsuficiente(lucro, lucroMinimo);

        _autorizar(ativo, pool, aDevolver);
        if (lucro > 0) IERC20(ativo).transfer(cofre, lucro);

        emit Cacada(devedor, garantia, lucro);
        return true;
    }

    /** Resgata token preso. Sempre para o cofre, nunca para quem chamou. */
    function resgatar(address token) external apenasDono {
        IERC20(token).transfer(cofre, IERC20(token).balanceOf(address(this)));
    }
}
