# Regras deste projeto

Escritas em 2026-09-27, depois de dez leituras erradas minhas em um dia. A dona
do bot perguntou: "o que precisamos pra voce parar de errar?". Eu classifiquei
os dez erros e todos caíram em quatro causas. Nenhuma delas era falta de
pesquisa, prompt ruim ou informação que faltasse dela.

Estas quatro regras existem para as próximas sessões, que não vão lembrar de
nada disto.

## 1. Nunca afirme um número que você não RODOU

Três dos dez erros foram aritmética minha numa mensagem:

- "o lance sai inteiro até US$ 11,69" — era US$ 6,90. Eu olhei o corte do gás
  adiantado e esqueci que `gorjetaQueCabeNoSaldo` corta antes, pela fração de
  risco.
- "o bot para de atirar em US$ 11,69" — para em US$ 66,76. Eu misturei duas
  perguntas diferentes.
- "a baleia de US$ 95M dá prejuízo de US$ 44M" — dá lucro de US$ 1.986, porque
  cobrir metade é escolha nossa e não obrigação da Aave.

E o inverso vale: **todo número que eu acertei veio de rodar código.** Todo
número que eu errei veio da minha cabeça.

Então: antes de escrever um número numa resposta, escreva um arquivo temporário
que importe a função de verdade e a rode. Se isso não for possível, diga que é
estimativa, em voz alta, na mesma frase.

## 2. Procure a medição que já existe ANTES de calcular

Dois erros foram eu inventando um número que o repositório já tinha medido:

- O log imprimiu "uma queda de 10% vale US$ 2.161.328". O verdadeiro é uns
  US$ 2.000. `src/venda.ts` já tinha a curva de escorregamento medida no pool, e
  o cabeçalho dele AVISA deste exato erro. Eu calculei de novo em vez de usar.
- "CONCENTRADO em poucos endereços" para 17 liquidantes com o maior levando 20%.
  Eu inventei o limiar `liquidantes < liquidações/2`, que não mede concentração
  nenhuma.

Então: `grep` o repositório pela grandeza antes de escrever uma fórmula nova.
`src/contratos.ts` guarda medições com endereço e data. `src/venda.ts` tem a
curva do pool. Se já existe, use; se discordar, diga por quê.

## 3. Uma regra em dois lugares é a mesma regra. Conserte os dois

Três erros foram eu consertar uma ponta e deixar a gêmea:

- O modo prova soltou o portão do TIRO e não soltou o filtro da SELEÇÃO — os
  alvos que ele existe para atirar ficaram fora da brasa.
- `pisoUsado` caiu no default porque o saldo era lido DEPOIS do placar.
- `faixaQueAtira` passou a devolver `null` na ponta de baixo ("não há piso") e
  continuou devolvendo o chão da varredura na ponta de cima. Mesma função, mesmo
  dia.

Então: depois de mudar uma regra, `grep` por todos os lugares que a implementam
— e por todos os lugares que a LEEM. Se dois lugares calculam a mesma coisa,
junte num só em vez de sincronizar na mão.

## 4. Não extrapole de uma janela pequena quando o histórico está disponível

Eu disse "a Aave da Base pode ter secado" a partir de 23 horas de observação. O
censo de 9,3 dias mostrou **61 liquidações, 6,6 por dia, ~198 por mês**.

A função `quandoFoiAUltimaLiquidacao` parava na primeira janela com achado e
jogava 8,7 dias de histórico fora. A resposta estava a um `eth_getLogs` de
distância, custando 3.000 CUs.

Então: antes de concluir "não tem", varra o histórico. Ele é barato e não
depende de esperar nada acontecer.

## A rede: LIBERADA em 2026-09-27

`mainnet.base.org` está na allowlist do ambiente. Dá para conferir a Base
direto daqui, em segundos. Isto resolveu a causa-raiz de metade dos dez erros:
antes, cada fato da rede custava um deploy e alguém colar o log — vinte minutos
por pergunta — e era esse atrito que me fazia preencher buracos com inferência.

Duas armadilhas medidas na hora de usar:

1. **O `fetch` do Node ignora o `HTTPS_PROXY`** e cai num caminho de rede com
   política mais estreita: ele devolve `Host not in allowlist` enquanto o
   `curl` passa, no MESMO instante. Use um dispatcher explícito:

   ```ts
   import { ProxyAgent, fetch } from 'undici';
   const agente = new ProxyAgent(process.env.HTTPS_PROXY!);
   await fetch(RPC, { dispatcher: agente, ... });
   ```

2. **O RPC público tem limites**, e eles falham em silêncio se você não olhar:
   `eth_getLogs` recusa acima de 2.000 blocos, e requisições em rajada são
   barradas. Sem repetição com espera, uma varredura devolve "0 encontrados",
   que é resposta falsa com cara de medição. Na primeira tentativa eu li 86,3%
   dos devedores e o script se recusou a concluir; com espera maior deu 100%.
   **Sempre declare a cobertura ao lado do resultado.**

Primeiro uso, em 2026-09-27: varri 3.286 devedores da Base e medi o degrau de
2% de forma independente. Deu US$ 89,55; o bot, com outro RPC, outra janela e
outro código, dizia US$ 91. **1,6% de diferença.** Foi a primeira vez que os
números do bot foram conferidos por fora.

Ainda assim: **peça o log quando a dúvida for sobre o que o bot ESTÁ fazendo.**
A rede diz o que é verdade na blockchain; só o log diz o que o bot entendeu.

## A decisão do gás, medida em 2026-09-27 — NÃO adicione

A dona do bot disse desde o começo "a gente não combinou de ficar nas
migalhas?". Eu derivei duas vezes dali, com números que pareciam bons, e as
duas vezes ela estava certa. Agora está medido, e fica escrito para as
próximas sessões não re-litigarem.

O censo mediu a concentração de CADA fatia que o gás abriria, nos últimos 9,3
dias da Aave na Base:

    faixa dela (até US$ 45)  51 liquidações entre 15 endereços, maior 18%  ABERTA
    0.01 ETH abre 6 novas     6 entre 2 endereços, maior 50%, top3 100%   TEM DONO
    0.02 ETH abre 7 novas     7 entre 2 endereços, maior 57%, top3 100%   TEM DONO
    0.05 ETH abre 9 novas     9 entre 4 endereços, maior 44%, top3  89%   TEM DONO
    0.1  ETH abre 10 novas   10 entre 4 endereços, maior 50%, top3  90%   TEM DONO

**Todas as fatias que o gás abre têm dono.** Dois endereços levaram 100% da
primeira. Colocar US$ 27 não compra oportunidade: compra o direito de disputar
com dois bots dedicados que levaram tudo por nove dias.

E há uma assimetria que piora: o lucro dela numa posição grande é limitado pelo
pool da Aerodrome em US$ 1.986 (`coberturaOtima`). Quem usa agregador cobre
mais da mesma dívida e ganha mais — então tem mais incentivo para pagar gorjeta
alta. Ela perderia o leilão por desenho, não por lentidão.

A faixa dela, ao contrário, é aberta: 15 endereços, ninguém acima de 18%. É
onde US$ 9 de gás compete de igual para igual.

**Conclusão: ficar nas migalhas. Não é conformismo, é o que os dados dizem.**

Se alguma sessão futura quiser reabrir isso, o teste é rodar o censo de novo e
olhar `oQueCadaSaldoAlcancaria`: se alguma fatia passar a dizer "fatia sem
dono", a conta muda. Até lá, não muda.

### ATENÇÃO, 2026-09-27 à noite: a EVIDÊNCIA acima está sob revisão

A decisão é dela e continua valendo por enquanto. Mas a tabela acima não prova o
que eu disse que provava, e a próxima sessão precisa saber disso antes de citá-la.

Dois defeitos meus, achados no mesmo dia:

1. **A linha "faixa dela (até US$ 45) 51 liquidações entre 15 endereços, maior
   18% ABERTA" foi medida com piso ZERO.** Ela contava liquidações de poeira que
   não pagam o próprio gás. Com o piso verdadeiro (US$ 0,45, o lucro mínimo que
   cobre o gás), são **10** liquidações em 9,3 dias entre **5** endereços. A
   afirmação "a faixa dela é aberta" não se sustenta nessa medição.

2. **Pior: todos os veredictos `>>> ESSA FATIA TEM DONO` estavam medindo
   barulho.** A regra era `total >= 5 && fatiaDoMaior >= 0.5` — inventada, como a
   anterior que este arquivo já registra. Calculei a chance do acaso produzir cada
   uma daquelas concentrações, com endereços igualmente bons sorteando entre si:

       6 eventos, 2 endereços, maior levou 3  ->  100%   (era "TEM DONO")
       9 eventos, 4 endereços, maior levou 4  ->   63%   (era "TEM DONO")
      10 eventos, 5 endereços, maior levou 5  ->   16%   (era "a SUA faixa tem dono")
      57 eventos, 17 endereços, maior levou 11 ->  0,73%
      20 eventos, 5 endereços, maior levou 10  ->  1,3%  (os MESMOS 50%)

   Nenhum dos três primeiros prova nada. E os dois últimos mostram por que a
   fração sozinha engana: 50% de 10 o acaso dá em 16% das vezes, 50% de 20 em
   1,3%.

O conserto está em `src/concentracao.ts`: o veredicto agora sai da **chance do
acaso** (limiar 5%), tem uma terceira resposta — "não dá para dizer" — e exige
campo, porque dois endereços dividindo igualmente não é mercado aberto, é
duopólio. Os limiares de amostra também são calculados (`chanceDeCampoMaior`),
não escolhidos.

**O que isto NÃO quer dizer:** não quer dizer "coloque dinheiro". Quer dizer que
o argumento "todas as fatias que o gás abre têm dono" está sem prova, nas duas
direções — e que 9,3 dias de história não bastam para decidir isso. O próximo
passo honesto é acumular mais janela de censo e reler, não inverter a decisão com
os mesmos dados.

### O erro nº 9 tem TRÊS versões, não duas. A terceira foi minha

Em 2026-09-28 o teste de chance do acaso que eu tinha acabado de escrever olhou os
dados reais — 51 liquidações entre 17 endereços, o maior com 22% — e imprimiu
**TEM DONO**. Exatamente o veredicto que este arquivo registra como errado.

A chance do acaso ali é 0,26%: o desvio **é** real. E mesmo assim não é dono. As
duas perguntas não são a mesma:

- *"o desvio é maior que o acaso?"* — com muitos eventos, qualquer
  desequilíbrio mínimo passa a ser detectável. Responde se é ruído.
- *"alguém está levando a maior parte?"* — é a FRAÇÃO, e é ela que decide se
  vale entrar, porque é ela que diz quanto sobra.

Trocar a primeira pela segunda é o mesmo erro com matemática melhor. `quemTemDono`
agora exige as duas: desvio real **e** fatia grande. E o padrão de força não foi
inventado outra vez — é o que já estava escrito aqui: metade ou mais é domínio;
com dez ou mais endereços e ninguém acima de um terço, é mercado aberto; entre um
terço e metade, não se escolhe um lado.

Se uma quarta versão desta regra aparecer, o teste que a barra é
`src/concentracao.test.ts`, no caso "17 endereços com o maior levando 22%".

### E teve QUARTA e QUINTA versão, no mesmo dia

O log das 10:44 de 2026-09-28, com o conserto já em produção, imprimiu dois
veredictos errados — um em cada direção:

1. **`naSuaFaixa: 11 entre 6 endereços, maior 5 de 11 (45%) >>> SEM DONO`.** O
   fallback da função não olhava a fração nenhuma: 45,5% não chega à metade
   (domínio) nem fica abaixo de um terço com dez endereços (aberto). O certo é
   "não dá para dizer".

2. **`0.05 ETH ... >>> fatia sem dono: o gás compra oportunidade de verdade`**,
   sobre 9 liquidações entre 4 endereços. Este é o perigoso: estava empurrando
   dinheiro. Medido: com 9 liquidações entre 4 endereços, **até um endereço
   levando METADE teria 19,6% de chance pelo acaso.** A amostra não responde à
   pergunta, em nenhuma direção. O meu teste de força olhava o caso extremo ("um
   levando TODAS"), que passa quase sempre — e não o limiar que importa, que é
   metade.

E a correção disso criou a quinta: o portão de força passou a barrar **25 de 30
liquidações entre 3 endereços** — 83%, domínio óbvio — porque com três jogadores
a fatia justa é 33% e "metade" não seria distinguível. O portão existe para
impedir afirmar AUSÊNCIA com amostra fraca, não para barrar uma constatação que a
própria amostra já mostrou. Então evidência positiva vem ANTES do portão.

A ordem final de `quemTemDono`, e ela está escrita no código na mesma sequência:

    1. um endereço só            -> o campo decide
    2. campo de dois             -> duopólio ou amostra curta
    3. fatia >= metade e não é acaso -> TEM DONO  (evidência positiva primeiro)
    4. nem metade seria distinguível -> NÃO DÁ PARA DIZER
    5. fatia < um terço, campo >= 10 -> SEM DONO
    6. o resto                   -> NÃO DÁ PARA DIZER

Cinco versões desta mesma regra em dois dias. O que cada uma errou não foi a
matemática: foi confundir três perguntas diferentes — "o desvio é real?", "a
fatia é grande?" e "esta amostra consegue responder?". Elas precisam das três.

## A varredura independente de 2026-09-28: o censo do bot confere

Varri a Base por fora, com o RPC público, 205 janelas de 2.000 blocos, cobertura
100%, 9,5 dias:

    por fora (meu)   51 liquidações entre 17 endereços, maior 11 (21,6%)
    o bot (censo)    57 liquidações entre 17 endereços, maior      19%

Janelas ligeiramente diferentes (9,5 contra 9,3 dias), 10% de diferença na
contagem, **mesmo número de endereços e mesma fatia do maior**. É a segunda vez
que os números do bot são conferidos por um caminho independente, e passaram.

Duas coisas que essa varredura mostrou e que o censo do bot não diz:

1. **Os últimos 1,9 dias tiveram 3 liquidações, não ~12.** A 6,2/dia do censo é a
   média dos 9,3 dias; o mercado ficou quieto no fim. Média não é o que vai
   acontecer amanhã.
2. **Quem levou a liquidação que o bot perdeu em 2026-09-28 (`0x111eda48…`) tinha
   levado 1 de 51 em 9,5 dias.** Não é bot dedicado. Ela não perdeu para uma
   máquina: perdeu para alguém que aparece uma vez a cada dez dias.

## POR QUE O BOT NUNCA ATIROU — medido em 2026-09-28, e não é defeito dele

Depois de dias consertando medições, a dona do bot perguntou: "por que você erra
tanto?". A resposta honesta era: eu estava consertando o termômetro em vez de
procurar a febre. Uma consulta de arquivo respondeu o que uma semana de logs não
respondeu.

A liquidação que o bot "perdeu" em 2026-09-28 (`0xe03754a8`, US$ 23,11, o alvo
estava NA BRASA, nonce nunca saiu de 4):

    bloco 51885442 (2 segundos antes): saúde 1.00330 — precisa cair 0,3291%
    bloco 51885443:                    LIQUIDADA

Ela passou de "falta 0,33%" para "liquidada" DENTRO DO MESMO BLOCO. Não existiu
nenhum bloco em que estivesse liquidável e disponível. O bot não chegou tarde:
não houve instante nenhum em que ele pudesse ter chegado.

Então varri as 51 liquidações dos últimos 9,5 dias (205 janelas, cobertura 100%
dos eventos) e conferi, para cada uma, a saúde UM BLOCO ANTES:

    32  levadas no MESMO bloco em que ficaram liquidáveis — janela ZERO
    11  tinham janela de pelo menos um bloco
     8  sem arquivo no RPC público para dizer (16% da amostra)

E as 11 com janela, medidas pela dívida em dólar que a própria Aave devolve
(`totalDebtBase`, sem mapa de preços meu):

    dívidas de US$ 0,20, US$ 0,26, US$ 0,31 … todas poeira
    lucro do bot: de -US$ 0,25 a -US$ 0,30 — TODAS abaixo do gás

**Zero liquidações em 9,5 dias foram ao mesmo tempo legíveis a tempo E valiosas o
bastante para pagar o próprio gás.** Conferido caso a caso com os números crus e
os links do basescan.

E a lógica é limpa, não é azar: **se vale dinheiro, é levada no mesmo bloco da
escrita do oráculo; se sobra tempo, é porque não vale nada.** É assim que um
mercado eficiente se parece por dentro.

### O que isto significa para a arquitetura

O bot lê o estado DEPOIS que o bloco foi minerado, detecta `queda.isZero()` e
então atira. Esse desenho só pode ganhar as que ficam liquidáveis por um bloco ou
mais — e essas, medido, valem menos que o gás. Não é lentidão de rede, de RPC nem
de código: é o desenho.

Para ganhar as outras 32 seria preciso estar NO MESMO BLOCO da atualização do
oráculo: prever a escrita da Chainlink pelo preço de fora e atirar
especulativamente (pagando gás nas erradas), ou ter acesso a bundle/mempool. É
outro bot. O caminho do `adiantar.ts` e da postura "dedo no gatilho" existe para
isso, mas nunca foi exercitado porque o mercado não se moveu o bastante.

### O que NÃO está provado aqui

- 8 das 51 (16%) não puderam ser medidas, por falta de arquivo no RPC público.
- É uma janela de 9,5 dias, e os últimos 1,9 dias tiveram só 3 liquidações.
- Isto não diz "o bot é inútil". Diz que o caminho de ler-e-reagir não ganha, e
  POR QUE. A decisão do que fazer com isso é dela.

Antes de reabrir esta conclusão, refaça a varredura: o script está descrito aqui
e leva uns oito minutos com o RPC público.

## 2026-09-28: eu mandei ela ligar uma chave que não fazia nada

Ela perguntou "tem certeza que não tem mais nenhum erro?". Eu respondi que não
tinha como ter certeza e rodei uma revisão no diff dos dois dias. Ela achou **15
defeitos**. O pior era sobre o que eu tinha acabado de mandar ela fazer.

Eu disse a ela: ligue `CACA_ACEITA_PREJUIZO=1`, porque o único alvo legível a
tempo vale -US$ 0,30 e `valeATentativa` recusa lucro não-positivo. **Errado.**

O lucro que chega em `decidirTiro` pelo caminho quente vem do contrato,
decodificado com `BigInt('0x'+...)` em `lerRespostaDaCaca`: é um inteiro **sem
sinal**, nunca negativo. A porta que eu disse que estava trancada nunca teve como
ser usada. Os -US$ 0,30 vêm de `lucroEstimado`, que é líquido do gás e serve o
censo — e nunca chega perto da decisão do tiro.

E quando escrevi o teste para provar o conserto, o teste me corrigiu outra vez: o
modo prova **já aceitava prejuízo**. Com margem zero, `valeATentativa` só exige
lucro acima de zero, então US$ 0,01 de lucro bruto contra US$ 0,22 de gás já
passava. `CACA_ACEITA_PREJUIZO=1` muda o comportamento em **um** caso: lucro bruto
exatamente zero.

### O que de verdade estava barrando

`if (leitura.desfecho === 'mediu' && leitura.lucroCru)` — `leitura.lucroCru` é um
bigint, e **`0n` é falso em JavaScript.** Uma medição de lucro exatamente zero,
que `lerRespostaDaCaca` devolve de propósito com `desfecho: 'mediu'`, era jogada
fora como "não mediu": o alvo era pulado com um `continue` seco e a linha de
recusa — a única que explica por que o bot não atirou — nunca saía.

Ausência com cara de resposta, no lugar mais caro do código.

### Outros dois que podiam custar o tiro

- **O ensaio em seco gastava um nonce.** Chamava `getNextNonce()`, que adianta o
  contador, e devolvia com um `sync()` sem proteção. Se esse `sync()` falhasse —
  limite de RPC, soluço de rede — o contador ficava em N+1 para sempre,
  `provaAgora()` passava a responder "já saiu tiro: a prova foi feita", e o bot
  desarmava o único tiro que está configurado para dar, sem nunca ter atirado. Um
  diagnóstico não pode gastar a munição que ele existe para conferir. Agora lê com
  `nonceConhecido()`.
- **`Number('0,5')` é `NaN`, em silêncio.** Vírgula decimal é o natural para quem
  escreve em português. Medido: `CACA_MORDIDA_MAXIMA='0,5'` faz
  `mataACacaDeMigalhas` chamar `BigInt(Math.round(NaN * 1e6))` e estourar
  `RangeError`, que o laço do caçador engole como "tropeço rápido na rede" — o bot
  nunca mais atira e o log culpa a rede. E `CACA_FRACAO_GORJETA='15%'` faz a
  gorjeta cair no piso para qualquer prêmio, apagando a mordaça e liberando tiros
  que a política correta recusa. Agora `politicaDoTiro` **morre no boot** dizendo
  o nome da variável torta.

### A lição, que é sobre mim e não sobre o código

Cinco versões de uma regra, uma chave que não fazia nada, e uma docstring que eu
tive de estreitar duas vezes na mesma hora. O padrão não é falta de cuidado: é eu
**afirmar o mecanismo sem seguir o valor até o fim do caminho**. Eu li
`valeATentativa`, vi o portão, e não fui ver de onde vinha o número que passa por
ele.

Antes de dizer "é este portão que barra", siga o valor: de onde ele nasce, por
quais funções passa, e que tipo ele tem. `lucroCru` é `bigint` sem sinal — isso
estava a um `grep` de distância.

Ainda restam defeitos da mesma revisão sem conserto, anotados para não se
perderem: o placar conta como "não teve" a liquidação que o bot atiraria
(`piso 0` contra tiro em prejuízo); `repartirPorFaixa` manda lucro não-positivo
para `dentro` quando `faixa.de` é `null`; o critério dos três maiores
(`fatiaDoTop3`) foi perdido na reescrita de `quemTemDono`, então um cartel de três
endereços lê como "não dá para dizer"; a cobertura do `olharAgora` diz 100% mesmo
com todas as janelas falhando; e `--varrer` apaga da memória o alvo semeado que
passou do corte.

## Como este projeto mede o próprio erro

O defeito que mais aparece aqui tem nome: **ausência com cara de resposta** —
um número que o algoritmo inventou (o chão de uma varredura, um default
esquecido, um piso desatualizado) publicado como se fosse medição.

Todo conserto vira teste com o caso real que o expôs, e o comentário diz o
número medido e a data. Não é zelo: é o único jeito de a próxima sessão não
repetir. Em 2026-09-27 os testes foram de 949 para 1.214 por causa disso.

## 2026-09-28, fim de tarde: "precisa cair X%" é falso para 8 dos 35 alvos

Um aviso do Gemini sobre o log — o alvo `0xc4d36f95` aparecer com garantia e
dívida na MESMA moeda — levou à medição que segue. **Dois dos três pontos dele
estavam certos**, e o primeiro é maior do que ele descreveu.

`quedaAteLiquidar` responde uma pergunta só: *"quanto a GARANTIA pode cair com a
dívida parada?"*. Isso é certo para garantia em WETH e dívida em USDC. Quando os
dois lados são a mesma moeda, o preço aparece em cima e embaixo da conta da saúde
e **se cancela** — a queda pedida não chega, por preço nenhum.

Medido na Base, com as funções deste repositório, cobertura 100% (35 de 35):

    8 IMUNES a preço, somando US$ 462,47 de "lucro" que o preço não entrega
    27 derrubáveis

E dentro do teto de tiro de US$ 66,78, nos 15 alvos da faixa:

    4 NUNCA caem por preço        US$ 136,71
    3 só num extremo de preço     US$  51,77   (piso entre 0,85 e 1)
    8 caem por preço de verdade   US$ 161,85

O caso que abriu tudo, `0xc4d36f95`, com LT 93% do E-Mode e 78% do cbBTC — os
dois **conferidos contra o limiar misturado que a própria Aave devolve**:

    ETH  -50%  ->  saúde 1,025110    <- CAIR deixa a posição MAIS SEGURA
    ETH    0%  ->  saúde 1,014448    (a Aave diz 1,014468)
    ETH +1000% ->  saúde 1,004756
    piso:          1,003785          <- e a ferramenta mediu 1,003785 depois

A conta está em `src/pisoDaSaude.ts` e é exata: uma razão de duas formas
lineares positivas tem ínfimo num vértice, então

    piso = MENOR, entre os ativos k com dívida, de
           (garantia em k) x (limiar de k) / (dívida em k)

`src/pisoAgora.ts` roda isso nos alvos guardados.

### Duas armadilhas, e cortam para lados opostos

1. **O piso é limite INFERIOR** (supõe preços independentes). Para par da mesma
   família — cbETH contra WETH, wstETH contra WETH, syrupUSDC contra USDC — ele
   sai ZERO e está formalmente certo, mas só se realiza num depeg. A baleia
   `0x67d0938f` (US$ 1,9M em WETH contra cbETH) lê como "cai" e na prática está
   muito mais perto de imune. **`piso >= 1` é conclusão; `piso = 0` não é
   promessa.**

2. **O preço não é a única causa, e havia uma terceira que eu não conhecia.**
   `0x43ec917e` é USDC contra USDC — imune — e mesmo assim andou 2,41 pontos de
   saúde em 70 minutos:

        14:30        15:40      variação
        saúde      1,044539    1,019343   -2,41%
        dívida US$   10.360      10.310   -0,48%
        garantia     13.874      13.474   -2,88%
        o juro explicaria:                 0,000266%   (9.000x pequeno demais)

   **O dono sacou US$ 400 de garantia.** Não foi mercado nem juro: foi a pessoa.
   E quando o dono age, a posição atravessa numa transação, num bloco — a
   "janela zero" que este arquivo já mediu em 32 das 51 liquidações, e que o
   desenho de ler-e-reagir estruturalmente não alcança.

   São TRÊS causas, e o bot só enxerga uma: **preço** (ele persegue), **juro**
   (`src/deriva.ts` calcula dias antes), **dono** (sem aviso).

### E o defeito que eu cometi medindo isto

A primeira rodada devolveu "10 de 35 não deu para medir". Não era propriedade
dos dados: eu lia a **palavra 1** do `getEModeCategoryData`, que é o LTV, no
lugar da palavra 2, que é o limiar de liquidação. A palavra 0 é o offset do
tuple dinâmico. E eu só sondei as categorias 1 a 4 quando existem 15.

O que salvou foi `limiaresConferem`: sem bater com o limiar da Aave, o piso não
é publicado. **O portão recusou 10 medições erradas em vez de imprimi-las.** É
para isso que ele existe — e é a diferença entre um buraco declarado e uma
ausência com cara de resposta.

### O que o Gemini errou

Não há erro de índice em `montarAlvos`. `escolherParPorValor` tem dois
acumuladores independentes; devolveu WETH/WETH porque a posição **é** WETH/WETH.

E a receita dele para o teste em fork se contradiz: derrubar o oráculo do ETH em
3% para liquidar `0xc4d36f95` não funciona — pelo achado dele mesmo, derrubar o
ETH deixa aquela posição MAIS SEGURA.

## 2026-09-28, 16h: o log dela mostrou DOIS defeitos que matavam o tiro

O log de produção trouxe `[EM SECO]` com `medicao: "revertido (execution
reverted)"` e o alvo `0xc4d36f950cdb…` com `garantia 0x4200…0006 / dívida
0x4200…0006`. As duas linhas esconderam um defeito cada.

### 1. O portão que autoriza gastar dinheiro estava sempre aberto

`naoCruzouAinda` existe para responder *"a recusa foi 'ainda não cruzou' ou foi
'minha configuração quebrou'?"* — e é ela que libera o tiro ANTES do cruzamento,
que manda transação real. **Rodado, e é o inverso do que o comentário dela
prometia:**

    naoCruzouAinda('execution reverted')        -> true
    naoCruzouAinda('revertido sem mensagem')    -> true
    naoCruzouAinda(undefined)                   -> true    <- ausência autoriza
    naoCruzouAinda('HealthFactorNotBelowThreshold()') -> FALSE  <- a resposta certa

Ela terminava em `/revert/i.test(mensagem)`. E **toda** prosa que
`lerRespostaDaCaca` monta para um desfecho `revertido` contém a palavra "revert":
`r.mensagem` do RPC é `"execution reverted"`, o padrão é a literal `'revertido'`,
e o caso sem motivo vira `'revertido sem mensagem'`. O portão era
sempre-verdadeiro, inclusive para erro do NOSSO contrato.

A identidade nunca esteve na prosa. Medido com `eth_call` no contrato V1 da Base,
no alvo real:

    message : "execution reverted"     <- nenhuma identidade
    data    : 0x930bb771               <- HealthFactorNotBelowThreshold()

`lerRespostaDaCaca` recebia esse `data` e o **descartava**, guardando só a
mensagem. Agora ele viaja em `dadosCrus`, e `naoCruzouAinda(mensagem, dados)`
decide pelo SELETOR. Sem identificação positiva não se manda dinheiro: reversão
opaca não se distingue de contrato quebrado.

**E não havia UM teste.** Escrevi a função e não a exercitei — foi exatamente por
isso que saiu invertida. Agora tem sete.

### 2. O tiro em moeda única não podia acertar, nunca

O pool de venda configurado, `0xcdac0d6c…`, é **WETH/USDC** — conferido na rede:
token0 = `0x4200…0006`, token1 = `0x8335…2913`. Numa posição WETH contra WETH,
`executeOperation` faz:

    liquidationCall(WETH, WETH, devedor, quantia)     -> recebe WETH tomado
    _venderGarantia(WETH, pool WETH/USDC, TODO o WETH) -> devolve USDC
    emCaixa = balanceOf(WETH) ~ 0
    lucro = 0  ->  revert LucroInsuficiente(0, piso)

Ele vende inclusive o WETH que precisa para pagar o empréstimo. A transação
inteira reverte. E a MEDIÇÃO desses alvos sai como lucro **zero**, então
`decidirTiro` recusa um alvo que talvez valesse.

Vale para os 8 alvos de moeda única que o censo achou — e o alvo do ensaio em
seco é justamente um deles.

**Não precisa de deploy novo.** O contrato já tem `if (poolDeVenda != address(0))`:
com o endereço zero ele pula a venda, e aí `emCaixa` é a garantia tomada, na
moeda certa. `poolParaVender` decide isso num lugar só — o pool era passado em
TRÊS (ensaio, medição e tiro), a regra em dois lugares de novo.

### A lição, e é a mesma de sempre

Os dois defeitos são a mesma forma: **eu afirmei o mecanismo sem seguir o valor
até o fim.** No primeiro escrevi um comentário longo dizendo para não aceitar
reversão opaca e terminei a função aceitando. No segundo escrevi "vende a
garantia" sem perguntar o que acontece quando a garantia é a própria dívida.

Os dois estavam a um `console.log` de distância.

## 2026-09-28, 17h: os quatro consertos que ela mandou fazer

### 1. O V2 nunca esteve quebrado — ele era INMENSURÁVEL

`0x42301c23` é **`InsufficientOutputAmount()` do router da Aerodrome**, e a
causa é nossa: `CacadorV2._venderGarantia` passa `aDevolver + minProfit` como
`amountOutMin` **para o router**. Com o piso impossível da medição, o router
recusa **antes de executar qualquer coisa**.

Como o bot só atira em cima de medição, e a medição do V2 sempre revertia, **o
V2 estava morto para a decisão** — e quase todo alvo que cai por preço é
multi-ativo, ou seja, dele.

Medido com o oráculo forçado, bloco 51912429:

    V2 com piso 0 ....... passou
    V2 por bisseção ..... 323.009.925 unidades
    V1 no mesmo bloco ... 323.009.946 unidades

21 unidades de diferença em 323 milhões. É o mesmo caminho.

O conserto é `pisoParaMedirV2`: medir o V2 no **limiar da decisão** em vez do
piso impossível. A resposta vira sim/não no único ponto que importa — "o lucro
cobre o que o tiro custa" — e quem julga continua sendo `decidirTiro`, com o
mesmo custo. Não precisa de deploy de contrato.

### 2. O piso de US$ 22,13 e as 10 vagas, no modo prova

O censo mediu que **31 das 52 liquidações (60%)** acontecem abaixo do piso
normal. Com as 10 vagas reservadas, o bot vigiava dez desses e deixava 2.374
fora da patrulha rápida — justamente o grupo onde a prova tem chance.

No modo prova o piso cai para US$ 0,50 (`CACA_PISO_DA_PROVA_USD`) e as 233 vagas
ficam todas disponíveis. Fora do modo prova nada muda: o piso existe porque uma
dívida de US$ 1 não paga o próprio gás.

### 3. Os imunes a preço saem da FRENTE da brasa

No log das 16:58 o `[EM SECO]` mirava `0x43ec917e`, que é USDC contra USDC e
nunca cai com o mercado, enquanto os sensíveis esperavam atrás.

`oPrecoCancela` é o corte barato do laço quente: mesma moeda, ou as duas na
mesma família (ETH de staking contra ETH, dólar contra dólar). Quem é imune vai
para o **fim** da fila, não para fora dela — o dono ainda pode sacar garantia e
derrubar a posição num bloco.

`precoCancela === undefined` conta como sensível: o par só é conhecido depois de
`montarAlvos`, e **quem não se sabe fica na frente**. O custo de vigiar um imune
por engano é uma vaga; o de deixar um sensível de fora é o tiro.

### 4. Modo kamikaze na gorjeta do tiro de prova

O log media `gorjeta 2.49 gwei (AMORDAÇADA — queria 7.02)` num prêmio de
migalha: desvantagem no leilão justamente no único tiro que precisa ser ganho.
No modo prova a gorjeta desejada passa a ser o **teto da carteira**, e quem corta
é só `gorjetaQueCabeNoSaldo`. Fora do modo prova nada muda.

### E o defeito que esse conserto criou, achado pelos testes

Com o kamikaze, `soPassouPorSerProva` passou a avaliar a regra normal **com a
gorjeta kamikaze**: o prêmio de US$ 1.986 aparecia como "passaria normal"
(1986 > 2 × 4,76) enquanto a regra normal, com a gorjeta dela, recusava. O rótulo
que existe para impedir o primeiro acerto de parecer lucro legítimo apagava-se
sozinho.

Agora a pergunta é feita inteira, com os números do tiro normal
(`prioridadeNormalWei`, `custoNormalUsd`, `mataNormal`) — e a **frase segue o
rótulo**, em vez de um dos motivos dele. Antes ela só saía quando `mata.pula`,
então um tiro marcado `soPassouPorSerProva` podia ser publicado com a frase de
um tiro normal: a etiqueta e o texto discordando sobre o mesmo tiro.
