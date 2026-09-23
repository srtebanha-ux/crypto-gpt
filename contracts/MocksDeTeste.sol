// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Dublês para testar `CacadorDeLiquidacoes` numa EVM local.
 *
 * NÃO VÃO PARA REDE NENHUMA. Existem para que o ciclo inteiro — empréstimo,
 * liquidação, venda, devolução, lucro — possa ser executado e CONFERIDO aqui,
 * antes de qualquer deploy e antes de qualquer dinheiro.
 *
 * O que um dublê precisa ter para o teste valer: as mesmas EXIGÊNCIAS do
 * original. Uma Aave de mentira que entregasse o empréstimo sem cobrar de
 * volta provaria que o contrato funciona num mundo onde ele não precisa
 * funcionar. Por isso `PoolFalso` puxa o pagamento com `transferFrom` e
 * reverte se a autorização faltar — igualzinho à de verdade.
 */

contract TokenFalso {
    string public nome;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error SaldoInsuficiente(address de, uint256 tem, uint256 quer);
    error AutorizacaoInsuficiente(address de, uint256 tem, uint256 quer);

    constructor(string memory _nome) {
        nome = _nome;
    }

    function criar(address para, uint256 quanto) external {
        balanceOf[para] += quanto;
    }

    function transfer(address para, uint256 quanto) external returns (bool) {
        if (balanceOf[msg.sender] < quanto) revert SaldoInsuficiente(msg.sender, balanceOf[msg.sender], quanto);
        balanceOf[msg.sender] -= quanto;
        balanceOf[para] += quanto;
        return true;
    }

    function approve(address quem, uint256 quanto) external returns (bool) {
        allowance[msg.sender][quem] = quanto;
        return true;
    }

    function transferFrom(address de, address para, uint256 quanto) external returns (bool) {
        uint256 permitido = allowance[de][msg.sender];
        if (permitido < quanto) revert AutorizacaoInsuficiente(de, permitido, quanto);
        if (balanceOf[de] < quanto) revert SaldoInsuficiente(de, balanceOf[de], quanto);
        allowance[de][msg.sender] = permitido - quanto;
        balanceOf[de] -= quanto;
        balanceOf[para] += quanto;
        return true;
    }
}

interface IReceptorDeFlashLoan {
    function executeOperation(
        address ativo,
        uint256 quantia,
        uint256 premio,
        address iniciador,
        bytes calldata dados
    ) external returns (bool);
}

contract PoolFalso {
    /** Prêmio do empréstimo, em centésimos de por cento. 5 = 0,05%. */
    uint256 public premioBps;
    /** Ágio da liquidação, em centésimos de por cento. 500 = 5%. */
    uint256 public bonusBps;
    /** Se true, recusa a liquidação como a Aave faz com posição saudável. */
    bool public posicaoSaudavel;

    error HealthFactorNotBelowThreshold();

    constructor(uint256 _premioBps, uint256 _bonusBps) {
        premioBps = _premioBps;
        bonusBps = _bonusBps;
    }

    function definirSaudavel(bool v) external {
        posicaoSaudavel = v;
    }

    function flashLoanSimple(
        address receptor,
        address ativo,
        uint256 quantia,
        bytes calldata dados,
        uint16
    ) external {
        TokenFalso t = TokenFalso(ativo);
        t.transfer(receptor, quantia);
        uint256 premio = (quantia * premioBps) / 10_000;

        IReceptorDeFlashLoan(receptor).executeOperation(ativo, quantia, premio, receptor, dados);

        // Puxa de volta. Se o receptor não autorizou o suficiente, isto
        // reverte — que é exatamente o que a Aave de verdade faz, e é o que
        // torna este teste capaz de reprovar um contrato que não paga.
        t.transferFrom(receptor, address(this), quantia + premio);
    }

    function liquidationCall(
        address garantia,
        address divida,
        address,
        uint256 quantoCobrir,
        bool
    ) external {
        if (posicaoSaudavel) revert HealthFactorNotBelowThreshold();
        // Cobra a dívida de quem chamou...
        TokenFalso(divida).transferFrom(msg.sender, address(this), quantoCobrir);
        TokenFalso(garantia).transfer(msg.sender, (quantoCobrir * (10_000 + bonusBps)) / 10_000);
    }
}

/** Par estilo Uniswap V2, só com o necessário para o caminho de venda. */
contract ParFalso {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;

    constructor(address _t0, address _t1, uint112 _r0, uint112 _r1) {
        token0 = _t0;
        token1 = _t1;
        r0 = _r0;
        r1 = _r1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }

    function swap(uint256 out0, uint256 out1, address para, bytes calldata) external {
        // O V2 não puxa: quem entrega é o chamador, antes de chamar. As
        // reservas são atualizadas com o que chegou de fato.
        uint256 saldo0 = TokenFalso(token0).balanceOf(address(this));
        uint256 saldo1 = TokenFalso(token1).balanceOf(address(this));
        if (out0 > 0) TokenFalso(token0).transfer(para, out0);
        if (out1 > 0) TokenFalso(token1).transfer(para, out1);
        r0 = uint112(saldo0 - out0);
        r1 = uint112(saldo1 - out1);
    }
}

/**
 * Duble de pool no estilo Solidly (Aerodrome e parentes).
 *
 * Tres diferencas em relacao ao ParFalso, e as tres sao o motivo de este
 * arquivo existir em vez de reusar aquele:
 *
 * 1. `getReserves()` devolve uint256, nao uint112. E o formato que faz o
 *    contrato antigo reverter, ou — pior — decodificar por acidente.
 * 2. Expoe `getAmountOut`, que e como o caçador descobre que esta diante de
 *    um pool que calcula sozinho.
 * 3. A taxa e de CONSTRUÇÃO, nao 0,3% fixo. E o ponto todo: se o caçador
 *    ainda estivesse calculando com 997/1000, o valor pedido nao bateria com
 *    o que este pool aceita entregar, e a troca reverteria.
 *
 * `taxaBps` diferente de 30 no teste e o que prova que a taxa deixou de ser
 * escrita a mao. Com 997/1000 embutido, o teste falha.
 */
contract ParSolidlyFalso {
    address public token0;
    address public token1;
    uint256 private r0;
    uint256 private r1;
    uint256 public taxaBps;

    constructor(address _t0, address _t1, uint256 _r0, uint256 _r1, uint256 _taxaBps) {
        token0 = _t0;
        token1 = _t1;
        r0 = _r0;
        r1 = _r1;
        taxaBps = _taxaBps;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (r0, r1, 0);
    }

    function getAmountOut(uint256 entrada, address tokenEntrada) external view returns (uint256) {
        (uint256 rIn, uint256 rOut) = tokenEntrada == token0 ? (r0, r1) : (r1, r0);
        uint256 comTaxa = entrada * (10000 - taxaBps);
        return (comTaxa * rOut) / (rIn * 10000 + comTaxa);
    }

    function swap(uint256 out0, uint256 out1, address para, bytes calldata) external {
        uint256 saldo0 = TokenFalso(token0).balanceOf(address(this));
        uint256 saldo1 = TokenFalso(token1).balanceOf(address(this));
        // A checagem que um pool de verdade faz: o que sai nao pode passar do
        // que a curva permite pelo que entrou. E ela que reverte quando quem
        // chama calculou com a taxa errada.
        uint256 entrou0 = saldo0 - r0;
        uint256 entrou1 = saldo1 - r1;
        uint256 permitido = entrou0 > 0
            ? (entrou0 * (10000 - taxaBps) * r1) / (r0 * 10000 + entrou0 * (10000 - taxaBps))
            : (entrou1 * (10000 - taxaBps) * r0) / (r1 * 10000 + entrou1 * (10000 - taxaBps));
        require(out0 + out1 <= permitido, "ParSolidlyFalso: saida acima da curva");
        if (out0 > 0) TokenFalso(token0).transfer(para, out0);
        if (out1 > 0) TokenFalso(token1).transfer(para, out1);
        r0 = saldo0 - out0;
        r1 = saldo1 - out1;
    }
}

/**
 * Duble de roteador de swap (1inch, Odos, Aerodrome router).
 *
 * O contrato nao sabe mais calcular nada de DEX: ele autoriza o roteador a
 * puxar o colateral e repassa um payload montado fora da cadeia. Entao o que
 * o teste precisa controlar e justamente o que volta — inclusive voltar
 * MENOS que o prometido, que e o caso de deslizamento que a trava de lucro
 * existe para pegar.
 *
 * Puxa por `transferFrom` de proposito: um roteador que recebesse sem
 * autorizacao provaria que o contrato funciona num mundo onde ele nao precisa
 * autorizar direito.
 */
contract RoteadorFalso {
    function vender(address tokenEntra, uint256 quantoEntra, address tokenSai, uint256 quantoSai) external {
        TokenFalso(tokenEntra).transferFrom(msg.sender, address(this), quantoEntra);
        TokenFalso(tokenSai).transfer(msg.sender, quantoSai);
    }
}
