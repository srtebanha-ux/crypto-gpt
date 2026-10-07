# Regras deste projeto

Escritas em 2026-09-27, depois de dez leituras erradas minhas em um dia. A dona
do bot perguntou: "o que precisamos pra voce parar de errar?". Eu classifiquei
os dez erros e todos caíram em quatro causas. Nenhuma delas era falta de
pesquisa, prompt ruim ou informação que faltasse dela.

Estas quatro regras existem para as próximas sessões, que não vão lembrar de
nada disto.

## REGRA 0 — PROIBIDO PEDIR DEPLOY COM BASE SÓ EM `npm test`

Escrita pela dona do bot em 2026-09-28, depois de uma tarde servindo de QA no
Railway: cinco minutos de varredura a cada deploy para descobrir que o código
continuava quebrado em produção.

**Teste unitário não pega o que quebrou naquele dia.** Os três defeitos foram:

1. **Ordem de leitura.** `precoCancela` só era preenchido depois de
   `montarAlvos`, que com a postura "dormindo" nunca rodava. Então TODO alvo
   tinha par desconhecido, "desconhecido conta como sensível" punha os imunes na
   frente, e o `[EM SECO]` mirou `0x034a3304` — weETH contra WETH — publicando
   `precisa cair 0.0434%` sobre uma posição que nenhuma queda alcança.
2. **Estado contraditório.** `[BLOCO]` imprimiu `vagasDeProva: "nenhuma (modo
   prova desligado)"` 100ms antes de `[EM SECO]` imprimir `tiroDeProva: ARMADO`.
   Duas linhas do mesmo log discordando sobre o mesmo estado.
3. **Endereço inventado.** A lista de famílias tinha `0x80d1e0f4…`, que eu
   escrevi de cabeça e não existe. Endereço de cabeça é o mesmo defeito que este
   arquivo persegue, só que em hexadecimal.

Os 1.298 testes passavam em todos os três.

**Então: `mainnet.base.org` está na allowlist deste ambiente. Antes de commitar
e pedir deploy, rode `npx tsx src/mostrarAFila.ts` e cole o JSON real na tela
dela.** Essa ferramenta roda as FUNÇÕES REAIS do caçador — `repartirPorFragilidade`,
`montarAlvos`, `oPrecoCancela`, `oQueUmaQuedaRenderia`, `codificarCacaV1/V2`,
`lerRespostaDaCaca` — contra os dados reais, e imprime o mesmo JSON que o log do
Railway imprimiria.

`montarAlvos` recebe o transporte por parâmetro exatamente para isso: a
ferramenta roda a mesma função, e não uma cópia dela. Uma cópia provaria a
cópia.

"Os testes passam" não é prova de nada sobre produção. **O JSON da rede é.**

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

## 2026-09-28, 17:41: a REGRA 0 funcionou na primeira vez que foi usada

Previsão feita no terminal às 17:34 (bloco 51913776) contra o log de produção
das 17:41 (bloco 51913980), sete minutos depois:

    terminal   maisPerto "precisa cair 2.4747%"   alvo 0xe2031ff0  cbBTC/USDC
    produção   maisPerto "precisa cair 2.4746%"   alvo 0xe2031ff0  cbBTC/USDC

Mesmo endereço, mesmo par, 0,0001 ponto de diferença. **É a primeira vez neste
projeto que o comportamento de produção foi previsto antes do deploy em vez de
descoberto depois.**

E os três consertos apareceram no log dela:

    maisPerto         0.0434%  ->  2.4746%
    seOMercadoCair    1%: 3 alcanço  ->  1%: 0 alcanço
    [EM SECO]         weETH/WETH (imune)  ->  cbBTC/USDC (sensível)
    vagasDeProva      "nenhuma (modo prova desligado)" com o modo ARMADO
                      ->  "nenhuma RESERVADA — e não precisa: está ARMADO…"

O `[PARES]` mediu: **121 candidatos, 65 imunes — 54%.** Era essa massa que
furava a fila.

### E o defeito que eu publiquei no log que criei para consertar defeitos

A linha `[PARES]` saiu com `jaSabia: 6575`, afirmando conhecer o par de 6.575
devedores quando conhecia 121. O número era `medidos.length - aResolver.length`
— "todo o resto" —, e a maior parte do resto está FORA do corte de 10%: nunca
foi perguntado, não é sabido.

Etiqueta que não descreve o conjunto, no log recém-nascido cujo propósito é
justamente esse. Agora são três contas separadas, porque respondem perguntas
diferentes: `jaSabia` (dentro do corte, já conhecido), `naoCoubeNoTeto` (dentro
do corte, ficou para a próxima volta) e `foraDoCorte` (acima de 10%, **não foram
perguntados**).

E `src/mostrarAFila.ts` rodou com `margemQuente = 15` enquanto o caçador usa 25
(`CACA_MARGEM_QUENTE`), publicando `naListaQuente: 35` contra os `323` do
Railway — um número meu que não confere com produção, na ferramenta que existe
para conferir com produção. Agora lê a mesma constante.

## 2026-09-28, 17:53: o KAMIKAZE inverteu a mordaça, e a faixa supunha a direção

Ela viu no log, duas linhas do mesmo `[EM SECO]`:

    numDeUS$88       "gorjeta 2.49 gwei (inteira)"
    lanceInteiroAte  "nenhum prêmio com lance inteiro"

Medido com o saldo real (0,003341 ETH, baseFee 0,005 gwei, bloco 51914502):

    prêmio      desejada  conseguida  amordaçado?
    US$ 0,05      2,506      1,188        sim
    US$ 20        2,506      1,414        sim
    US$ 66        2,506      2,362        NÃO
    US$ 1986      2,506      2,501        NÃO

**Fora do modo prova** a gorjeta desejada CRESCE com o prêmio e o teto do saldo
para de crescer: uma vez amordaçado, amordaçado para sempre, e `faixaQueAtira`
podia testar o chão e desistir. Era isso que o comentário dela dizia, e estava
certo.

**No kamikaze** a desejada é CONSTANTE (o teto da carteira) e quem cresce é a
conseguida, pela fração de risco. A região do lance inteiro vira **[X, ∞)** em
vez de **[chão, Y]** — e a busca, que testava o chão primeiro, via mordaça e
desistia.

A busca agora não supõe direção: testa as duas pontas e encontra a fronteira do
lado em que ela estiver. `inteiroDe` é a ponta nova, e a frase do log segue a
FORMA da região:

    A PARTIR de US$ 48,65 (R$ 262,70) o lance sai inteiro. ABAIXO disso eu
    atiro amordaçada — a gorjeta é o teto da carteira, mas a fração de risco
    corta quando o prêmio é pequeno

É a terceira vez em dois dias que um conserto meu cria um defeito na etiqueta ao
lado: o kamikaze quebrou `soPassouPorSerProva` (achado pelos testes), a REGRA 0
quebrou `jaSabia` (achado no log dela), e agora a monotonicidade de
`faixaQueAtira` (achado por ela, na contradição entre duas linhas vizinhas).

O padrão é sempre o mesmo: **mudei o mecanismo e não fui reler o que o lia.** É
a regra 3 deste arquivo, e ela continua me pegando.

## 2026-09-28, 18:03: o buraco da REGRA 0 era o log não dizer com que BOTÕES decidiu

O conserto do `inteiroDe` funcionou em produção — mas com um número diferente
do meu:

    terminal   inteiroDe US$ 49,27
    produção   inteiroDe US$ 34,63

Mesmo saldo, mesmo baseFee, mesmo preço do ETH. 30% de diferença que eu não
tinha como explicar. Medido, varrendo um botão por vez:

    risco máximo 0.6 (padrão daqui) ...... US$ 49,27
    risco máximo 0.8 ..................... US$ 34,63   <- o Railway dela
    risco máximo 1.0 ..................... US$ 27,79
    fração da gorjeta 0.15 ............... US$ 49,27   (não muda nada)

**O Railway dela tem `CACA_RISCO_MAXIMO=0.8`, e o terminal daqui usa 0.6.** O
código estava certo; o que faltava era o log DIZER com que botões ele decidiu.

Sem isso a REGRA 0 tem um buraco: a ferramenta roda as funções reais contra os
dados reais, mas com a CONFIGURAÇÃO daqui. Duas máquinas, dois conjuntos de
botões, e nenhuma linha ligando um ao outro.

Agora o `[EM SECO]` imprime `osBotoes` com `comoLerAPolitica`:

    gás 1200000 | gorjeta 0.4 do lucro | risco 0.25→0.6 do saldo | margem 2x
    | mordida máx 0.5 | amordaçado não | aceita prejuízo não

Quem conferir daqui roda com os mesmos números. É a diferença entre "previ e
bateu" e "previ, não bateu, e não sei por quê".

E `CACA_FRACAO_GORJETA` não mexe no `inteiroDe` **no modo kamikaze**, e isso é
consistente: ali a gorjeta desejada é o teto da carteira, não uma fração do
prêmio. A fração volta a mandar fora do modo prova.

### O `[PARES]` ficou MUDO, e silêncio não é resposta

Na segunda varredura completa (18:18) a linha `[PARES]` simplesmente não saiu.
A causa é boa — `aResolver` estava vazio porque os 124 já eram conhecidos, o
que **prova que a memória dos pares persiste entre varreduras**. Mas a ausência
da linha é indistinguível de "a função não rodou" ou "estourou".

Eu tinha feito a previsão de que `jaSabia` subiria de `0 de 124` para perto de
124. Ela falhou na forma: a linha desapareceu. O mecanismo estava certo, o meu
palpite sobre a forma do log estava errado, e a lição é a mesma — **o log tem de
dizer que não havia nada, em vez de não dizer nada.**

### E o `seOMercadoCair` sem o 2% e o 3% era corrupção do log, não do código

`comoLerAsQuedas` produz a string inteira — rodado. E o `[EM SECO]` da mesma
linha do log tinha tudo. O `[BLOCO]` chegou cortado, junto com "suborno sonoro"
(era dinâmico), "cubo no máximo" (cubro), "2 encontros encontrados" (endereços) e
o censo repetido três vezes. Antes de caçar o defeito, vale conferir se o log
chegou inteiro.

## 2026-10-06: três dias sem tiro, e o que a medição disse

Ela mandou o log de três dias com `tiros: "Nenhum tiro ainda."` e perguntou "?".
A tentação era responder "o mercado está calmo" — que é ausência com cara de
resposta. Quatro varreduras depois, nenhuma dessas respostas era a certa.

### O que ESTÁ medido, com a cobertura ao lado

**Liquidações na Base inteira, 30 dias, cobertura 99,9% (2.591 de 2.593 janelas
de 500 blocos).** Varrido SEM filtro de contrato, por cinco assinaturas com o
`topic0` calculado por keccak na hora — a corrente diz quem são os credores, e
nenhum endereço foi escrito de cabeça:

    Morpho Blue  0xbbbbbbbb…   822 liq. | US$ 1.210.292 | maior 88.926 | 488/794 pagam o gás
    Aave V3      0xa238dd80…   216 liq. | US$   226.082 | maior 94.643 |  47/207 pagam o gás
    Compound V2  (30 mercados) 316 liq. | US$    62.298 | maior 21.383 |  48/227 pagam o gás

**A Aave — a única que o bot vigia — é 16% das liquidações da Base.** O Morpho é
61% delas, 5,3x o bolo estimado, e 61% das dele pagam o próprio gás contra 23%
na Aave. 126 das 1.354 ficaram sem preço, 122 por serem tokens fora da lista do
oráculo da Aave: é piso, não teto.

**O ritmo do oráculo, pelos eventos `AnswerUpdated`, 7 dias, cobertura 92,9%
(ETH) e 90,9% (cbBTC):**

    ETH/USD    0xd772f6d9…  121,7 escritas/dia | salto p50 0,1603% p90 0,2216% máx 1,36%
    cbBTC/USD  0x13723399…  167,7 escritas/dia | salto p50 0,1143% p90 0,1663% máx 0,47%

Daí sai o limiar de escrita: **0,151% e 0,103%** — e o `DESVIO_TIPICO_PCT` era
0,5 por palpite, de 3,3 a 4,9 vezes maior. Como `posturaPorMargem` arma 'atento'
em `desvio × 0.6` = 0,30% e o desvio antes de uma escrita chega a 0,22% no p90,
**a postura 'atento' nunca armou**. Não era o mercado parado: era o portão
pedindo mais desvio do que o oráculo precisa. Corrigido em `0fa11cb`.

E o que isso NÃO resolve: o oráculo persegue o mercado dentro de 0,10–0,15%,
então o mercado nunca corre 1% na frente dele. Antecipar compra 0,15% de
dianteira, não 1%. **Um alvo a 0,99% não é alcançável por antecipação.**

**Episódios de queda abaixo do máximo das 24h** (ETH): −0,99% trinta vezes por
mês, −1,88% vinte e uma, −3,40% quatro. Os alvos cruzam. Esperar não é fé.

### E os TRÊS defeitos meus, todos da mesma família

1. **Número medido tem data de validade.** Em 02/10 medi o `mainnet.base.org`
   recusando `eth_getLogs` acima de 2.000 e cravei `PEDACO_MINIMO = 2000`. Em
   06/10 — quatro dias — o mesmo provedor respondeu `limited to a 500 range`. A
   sondagem parava ACIMA do teto, toda faixa falhava, e a varredura devolvia
   ZERO devedores em silêncio: o defeito exato que ela existe para evitar,
   criado pelo piso que eu escolhi. Um piso tem de alcançar qualquer teto
   plausível, não o que estava lá na terça.

2. **Cache de falha.** No script de tamanhos, uma recusa passageira do RPC era
   guardada como se fosse medição e envenenava o token para sempre: 25 das 32
   linhas saíram "NÃO SEI o preço". Agora só o SUCESSO é cacheado, e
   "o oráculo não lista este ativo" (resposta) está separado de "o RPC me
   recusou" (minha falha), porque pedem ações opostas.

3. **Fallback que inventa identidade.** Pior dos três, e veio DEPOIS de eu ter
   consertado o nº 2. Quando `underlying()` falhava, o script assumia "é ETH
   nativo a 18 casas" e precificava a US$ 4.200 — produziu uma linha de
   **US$ 212.304.815** para um mercado que era AERO, e um "lucro estimado" de
   US$ 11 milhões/mês que eu quase publiquei. Falha não tem valor padrão.

4. **Etiqueta que não descreve o conjunto**, no log que ela estava lendo para
   entender os três dias: `[BLOCO …] Só a brasa` imprimia
   `naListaQuente: "1324 (todos lidos)"` num ciclo que leu ZERO deles. A
   ternária veio copiada da varredura 'quentes' e só conferia o teto.

### A regra que sai disto

**Não extrapole de três dias.** O corte de 3 dias me enganou nas DUAS direções
no mesmo dia: primeiro disse que o Compound V2 era o prêmio (é o menor dos
três), depois fez o Morpho parecer trivial com US$ 142 (é o maior, com
US$ 1,2 milhão). E a média da rede é 44,7 liquidações/dia — aqueles três dias
tiveram 11/dia, quatro vezes abaixo. Já era a regra 4 deste arquivo; agora tem
dois exemplos meus no mesmo dia.

**E teste amarrado a um literal quebra a cada remedição.** Cinco testes falharam
por terem o 0,5 cravado nos valores de prova. Foram reescritos relativos à
constante: afirmam a REGRA — a faixa do 'atento' é [limiar × 0.6, limiar) — e
sobrevivem à próxima medição.

### A concentração no Morpho: SEM DONO, nos dois cortes

Medido no mesmo dia, cobertura **100%** (2.593 de 2.593 janelas), julgado pelo
`quemTemDono` deste repositório — e não por critério novo, porque a regra de
dono já errou cinco vezes aqui e as cinco estão registradas acima.

    todas as 822          72 endereços | maior 126 (15,3%) | top3 41%  >>> sem dono
    só as que pagam o gás 40 endereços | maior  96 (19,6%) | top3 43%  >>> sem dono

O veredicto, com as palavras da própria função: "o desequilíbrio é real (o acaso
daria em 0,00%), mas ninguém está acima de um terço com 40 endereços na mesa: é
mercado aberto, não domínio". As duas perguntas foram feitas separadas de
propósito — medir "a faixa dela" com piso zero foi o erro do censo de setembro.

**E a assimetria que a soma esconde: a mediana é US$ 141,96 de dívida**, uns
US$ 2,82 de lucro líquido. O US$ 1,2 milhão somado é carregado por um punhado de
grandes (88.926, 79.614, 52.394), e blocos repetidos no topo (51354208,
51354428) indicam liquidação PARCIAL da mesma posição em fatias. Então "490
pagam o próprio gás" não são 490 posições.

**`0xd12810b1…` aparece com 17 de 490.** É o mesmo endereço que o censo de
setembro apontou como líder na faixa dela na Aave (9 de 19). Os jogadores sérios
são multi-protocolo: é confirmação de que o Morpho importa e aviso de quem está
lá.

### O que NÃO está medido, e decide a próxima obra

**O incentivo real do Morpho Blue.** Assumi 5% em todas as contas acima; os
comptrollers do Compound deram 10% e 8%, lidos. Se o do Morpho for menor, menos
de 490 pagam o gás e a conta encolhe. Dá para medir dos próprios eventos, sem
lembrar fórmula: `seizedAssets × preço da garantia ÷ (repaidAssets × preço da
dívida)` é o bônus REALIZADO, caso por caso.

E a obra em si, se ela mandar: o Morpho Blue é outro mecanismo — `liquidate`
com callback em vez do `flashLoanSimple` da Aave, e a saúde é por mercado em vez
de um `getUserAccountData` só. Caminho novo no contrato e deploy novo.

## 2026-10-06, tarde: "ele vai atirar?" — os portões que faziam o bot calar

Ela perguntou, depois de perder alvos: *"eu só quero que ele atire na hora certa
e pegue o alvo de primeira"*. Tracei o caminho do tiro inteiro. **Sete portões
podem recusar**, e dois eram defeito.

Medido com o saldo dela (0,0158 ETH) e os botões de produção, a faixa que de
fato dispara: **de US$ 1,02 até SEM TETO**. O bot não é medroso — o único portão
que recusa é `margemMinima` de 2x, e ele nunca apareceu como causa de perda em
nenhuma medição.

### 1. O disjuntor era MUDO, e é o pior tipo de defeito

`if (disjuntorAberto) continue;` — sem uma linha de log. Ele abre com 8 derrotas
seguidas e só fecha quando um tiro acerta. Aberto, o bot via o alvo cair, media,
aprovava o tiro e **não mandava, em silêncio**. Para quem lê o log, "não atirei
porque o disjuntor está aberto" era idêntico a "não havia alvo".

Agora grita a cada alvo recusado, com o prêmio que deixou passar. E
`CACA_DISJUNTOR=0` desliga: com 0,0158 ETH que ela declarou 100% de risco, parar
após 8 derrotas é uma cautela que ela não pediu.

### 2. `eth_estimateGas` lento ABORTAVA o tiro — e o conserto quase foi pior

Sem estimativa em 800ms, `limiteDeGasDoTiro` devolvia `null` e o alvo se perdia.
A razão era boa (não morrer sem gás) e a conclusão estava errada: **morrer sem
gás só acontece com limite BAIXO.** Limite ALTO não tem esse risco — o nó congela
`gasLimit × maxFee` e DEVOLVE o que não foi consumido. Perder a liquidação por
um RPC lento é perda CERTA; lance apertado é só desvantagem.

**E aqui o teste vizinho me salvou.** Minha primeira versão usou 2.800.000 ("4x o
gás típico"), que é MENOR que o máximo já observado: o líder da faixa
(`0xd12810b1`) gastou entre 1.202.608 e **4.142.116** no MESMO contrato, 2,76x a
mediana. Teria reintroduzido exatamente o fracasso que o original temia. São
5.000.000 agora.

E os dois não cabem juntos no saldo dela: reservar 4 gwei de gorjeta limita o gás
a 4.099.653, abaixo do máximo medido. Então **sem estimativa o GÁS ganha da
gorjeta** — reserva só o piso do lance. Medido: manda 5.000.000, atira, 2,84 gwei
(sete vezes o maior lance da concorrência) e congela 0,014239 de 0,015821 ETH.

### 3. Um soluço de RPC no boot DESLIGAVA o bot para sempre

Achado por acidente, tentando rodar a REGRA 0 com o provedor estrangulado:

    [ERROR] Falha ao descobrir contratos base. {"erro":"over rate limit"}
    [ERROR] Configuração impede rodar. Não reinicio sozinho — corrija e reimplante.

Não havia nada errado na configuração. `principal()` devolvia 'parar', que faz o
laço de fora dar `return` e nunca mais reiniciar. **Boot é o que acontece em TODO
deploy** — um soluço de dois segundos no instante errado desligava o bot até
alguém abrir o log, com a mensagem mandando procurar no lugar errado.

Agora falha de TRANSPORTE lança e o laço reinicia; endereço que não responde com
o RPC vivo continua 'parar'. Conferido na rede: 43 reinícios onde antes era uma
morte.

### 4. A bússola morria a cada deploy, e isso enchia a brasa de IMUNE

O cache fazia os DEVEDORES sobreviverem e o que o bot sabia sobre eles morria
junto. Três consequências, e só a primeira é cosmética:

1. As tabelas inflam: `alcancaNaDirecao` conta desconhecido como alcançável
   (viés correto), e com 57 mil desconhecidos o log publicou **US$ 171.137 a
   10%**, dos quais 3.589 de 3.593 eram palpite.
2. **A BRASA ENCHE DE IMUNE.** Dos 600 pares reresolvidos após um deploy, 589
   eram imunes — 98%. Não é azar: ele resolve de cima para baixo da fila de
   fragilidade, e quem está no topo está lá PORQUE é imune (moeda única, o preço
   se cancela). Medido: com 600 conhecidos o `gatilhoEm` era 4,45%; com 5.000,
   14,54%; com 10.000, 15,82%.
3. Reencher custava 4 dias, e cada deploy zerava.

O campo `vias` no cache é opcional (cache velho continua servindo). E a gravação
tem de ser **no instante em que aprende**: a primeira versão só gravava na coleta
de 37 em 37 minutos, o container reiniciou aos 26, e perdeu tudo. Confirmado em
produção: a bússola foi de 5.000 para 9.998 atravessando um deploy.

### 5. As duas etiquetas que mentiam

- `naListaQuente: "1324 (todos lidos)"` numa linha chamada **"Só a brasa"**, que
  leu ZERO deles. A ternária veio copiada da varredura 'quentes'.
- As tabelas de queda só mudam na varredura COMPLETA e eram reimpressas a cada
  ciclo ao lado de campos ao vivo. Agora dizem a própria idade.
- E o `maior` de cada degrau agora diz `[par MEDIDO]` ou `[par SUPOSTO: pode ser
  imune]` — porque "187 de 190 são palpite" não responde em qual balde está o
  alvo em que ela vai mirar.

## 2026-10-06: o incentivo do Morpho é função do LLTV, e isso muda a estratégia

Medido nos eventos `Liquidate`, 10 dias, cobertura **100%** (1.385 janelas), 60
liquidações, todas resolvidas. Sem preço externo nenhum: o bônus sai de
`(seizedAssets × preço do oráculo DO MERCADO) / repaidAssets − 1`, e o oráculo do
Morpho já traz os decimais embutidos.

    LLTV  62,5%   26 liq.   bônus mediano 16,47%
    LLTV    77%    5 liq.   bônus mediano  9,27%
    LLTV    86%    9 liq.   bônus mediano  4,40%
    LLTV  91,5%    1 liq.   bônus mediano  2,73%
    LLTV  94,5%   17 liq.   bônus mediano  1,68%
    LLTV  96,5%    2 liq.   bônus mediano  1,11%

**Mediana geral 5,62%** — meus 5% assumidos estavam quase certos na média e
completamente errados onde importa. Os mercados de LLTV baixo (pares exóticos:
cbZEC, cbDOGE, cbLTC, cbXRP contra USDC) pagam **três vezes** o que eu assumi, e
são o maior grupo.

**A conclusão para a estratégia:** não é "entrar no Morpho". É entrar nos
mercados de **LLTV ≤ 77%**. Nos de LLTV alto o prêmio é tão magro que o gás come
quase tudo — a poeira da Aave de novo.

E uma observação de forma: **o Morpho liquida em RAJADA, não em fluxo.** 822 em
30 dias, mas 2 em dois dias e 60 em dez. A maior parte vem concentrada em poucos
dias de mercado ruim. Um bot lá fica parado quase sempre e precisa estar vivo e
rápido exatamente nos dias de queda forte.

A armadilha do método, declarada: o oráculo é lido AGORA e as liquidações são do
passado. Por isso a janela é curta. Com janela longa este número vira ficção.

## 2026-10-07: o placar morria no deploy, e o nonce sabia a resposta

O log dela das 10:32 de hoje imprimiu `tiros: "Nenhum tiro ainda."` com a
`conta_bot` em **nonce 6**. Duas transações saíram daquela carteira e o bot não
sabia de nenhuma.

A frase não estava mentindo sobre a memória dele — estava mentindo sobre o
**passado**. O placar morava em `let tiros = placarVazio()`, o Railway reinicia
o container várias vezes por dia, e a pergunta que mais importa ("ele já
atirou?") era respondida com a memória do boot de agora. Ausência com cara de
resposta, no número que decide se o bot funciona.

É a MESMA classe de defeito que a bússola, e o conserto é o mesmo arquivo: o
placar vai para o cache (`CacheDeDevedores.placar`, opcional, cache velho
continua servindo) e é gravado **no instante em que o tiro resolve**, não na
coleta de 37 em 37 minutos — a primeira versão da bússola gravava assim, o
container reiniciou aos 26 e perdeu tudo. Um tiro acontece algumas vezes por
MÊS: perder a contagem dele por esperar a coleta seria perder o evento mais raro.

E há uma segunda metade, que é a que importa mais: **o nonce já sabia.** Ele
conta transações saídas da carteira, nunca volta para trás, e já é lido no boot
de graça. `oQueACorrenteDiz` compara os dois e a frase passou a ser:

    Nenhum tiro que eu lembre. A corrente diz 6 transações já saídas desta
    carteira e eu contei 0 tiro(s): 6 saíram sem eu lembrar — antes deste boot,
    ou antes de existir cache. Confira no basescan.

"que eu lembre", e não "ainda": a contagem mora num cache que pode não ter
montado. O que o nonce NÃO diz é que toda transação foi um tiro — a carteira
poderia ter mandado outra coisa — então a frase fala em TRANSAÇÕES e manda
conferir, em vez de afirmar tiros que não foram contados.

Dois cuidados que os testes guardam: o lucro vai ao disco como TEXTO, porque
`JSON.stringify` de um `Decimal` grava os internos da biblioteca
(`{"s":1,"e":1,"d":[91,4]}`) e `new Decimal` não lê isso de volta — voltaria
zero em silêncio; e `disparados` na volta é o MÁXIMO entre o campo gravado e a
soma dos desfechos, senão um arquivo cortado faz a taxa de acerto passar de 100%.

### O teto do provedor mudou pela TERCEIRA vez em cinco dias

`src/olharAgora.ts` ainda tinha `const JANELA = 2_000` com o comentário
"Medido" — verdade em 02/10. Medido de novo hoje, com a função de sondagem:

    02/10   2.000 blocos
    06/10     500 blocos
    07/10     312 blocos   <- hoje, mesmo `mainnet.base.org`

Com o 2.000 cravado, as 160 janelas falhavam todas e a varredura devolvia zero
devedores — o defeito exato que `mostrarAFila.ts` sofreu ontem, na mesma linha.
Agora as duas ferramentas leem `tamanhosASondar` do caçador em vez de ter cada
uma a sua lista: é a REGRA 3, e a cópia provaria a cópia.

**Um número medido tem data de validade de DIAS, não de semanas.** Três leituras
do mesmo provedor em cinco dias, caindo. Quem cravar a quarta vai errar também.

### O que o log de hoje diz de bom

A bússola fechou: `0 ainda não sei`, de 57.811 devedores — 25.055 LONG, 5.514
SHORT, 5.564 AMBAS e **21.678 imunes (37,5%)**. Era isso que enchia a brasa de
imune a cada deploy, e agora não enche mais: `gatilhoEm` estabilizou em 14,51%
em vez dos 4,45% de uma bússola recém-nascida.

## 2026-10-07, 10:47: o PRIMEIRO alvo de verdade, e ele era inalcançável

O log dela das 10:47 trouxe `oraculoJaCaiuPct: 0.5254%` contra
`maisFragilA: 0.3733%`. Isso ou cruzou, ou é outro ativo — e a tabela tinha
931s, então ela não responde. Varri a corrente.

**Houve uma liquidação**, no bloco 52289907, dez segundos depois do `[BLOCO]`
das 10:32. Cobertura 100% (2 de 2 janelas de 312 blocos).

    devedor     0x6b950f306f987ff8fb9808886977ca2ef3af2c28
    garantia    WETH  (0x4200…0006)
    dívida      USDC  (0x8335…2913)   -> sensível a preço, NÃO imune
    dívida      US$ 2.163,90
    cobriram    US$ 1.081,95  (metade, como a Aave permite)
    levaram     0,438326 WETH = US$ 1.131,40  (preço do oráculo da Aave)
    BÔNUS       4,56%  =  US$ 49,33 BRUTO
    liquidante  0x6a60a8a1066b775233d540ed12bad0dd1eee6cc4
    tx          0x94410b70…  transação 6 de 537 do bloco

**US$ 49,33 é o primeiro alvo de verdade que este projeto mede.** Não é poeira:
o censo de setembro varreu 9,5 dias e concluiu "zero liquidações foram ao mesmo
tempo legíveis a tempo E valiosas o bastante para pagar o próprio gás". Esta era
valiosa. A outra metade da frase é que decide.

### A janela: ZERO, outra vez

A saúde, lida com paciência depois de uma recusa do RPC que eu NÃO aceitei como
medição (`over rate limit` é minha falha, não resposta):

    bloco 52289905   HF 1.00184180   dívida US$ 2.163,90   falta cair 0,1838%
    bloco 52289906   HF 1.00184180   dívida US$ 2.163,90   falta cair 0,1838%
    bloco 52289907   HF 1.12846310   dívida US$ 1.081,95   LIQUIDADA

Não existiu bloco nenhum em que estivesse liquidável e disponível. É o mesmo
padrão que este arquivo mediu em 32 das 51 liquidações de setembro, agora
confirmado sobre um prêmio de US$ 49 em vez de poeira. E a liquidação foi a
transação **6 de 537**: quem levou pagou para estar na frente do bloco. **É
leilão, não corrida** — e o `adiantar.ts` existe para isso.

### O que isto NÃO explica, e é a parte que pode ser defeito

Esta posição precisava de **0,1838%**. O log dela, no bloco 52289902 — cinco
blocos antes —, disse `maisFragilA: "0.3733% (entre os que pagam o próprio
gás)"`. Com US$ 2.163,90 de dívida ela paga o gás com folga, e a brasa corta em
`gatilhoEm: 14,5090%`: se o bot tivesse lido esta posição, ela seria a PRIMEIRA
da brasa e o `maisFragilA` teria dito 0,1838%.

**Então o bot não a tinha lido.** E este devedor não emite `Borrow` há mais de
**20,8 horas** — varrido daqui, 37.440 blocos, cobertura 99,2% (119 de 120
janelas). Ou seja: só o cache de 3 anos o acharia. A pergunta que fica, e que
só o log dela responde, é se ele está entre os 57.811 e não foi lido, ou se não
está lá.

#### E o defeito meu nessa medição, que a conclusão esconderia

A primeira versão desta varredura filtrou `topics[3]` e publicou "15,6 horas".
`topics[3]` do `Borrow` é o **`referralCode`**. Quem deve está em `topics[2]`
(`onBehalfOf` indexado) — e `devedoresDosEventos`, neste repositório, já diz
isso no próprio comentário:

    Borrow(reserve indexed, user, onBehalfOf indexed, ...)

Então o filtro casava com um campo que não tem nada a ver, e "nenhum achado" era
garantido por construção: **ausência fabricada pelo método**, com cara de
medição, no mesmo dia em que este arquivo ganhou um capítulo sobre isso.

Refeita no campo certo — e passando cada evento por `devedoresDosEventos` em vez
de pela minha leitura do tópico — a resposta foi a MESMA. Isso não absolve o
primeiro número: ele acertou por sorte, e um número que acerta por sorte não é
medição. É a regra 2 outra vez: a medição já existia no repositório e eu escrevi
a minha ao lado.

### Dois becos sem saída, DECLARADOS

1. **`adiantar.ts` mediu o feed CERTO.** Cheguei a suspeitar do contrário:
   `getSourceOfAsset(WETH)` no oráculo da Aave devolve `0x9da00d23…`, e o
   arquivo registra o agregador `0xd772f6d9…`. Rodado: `aggregator()` de
   `0x9da00d23` **é** `0xd772f6d9b7a35cb9…`. É proxy e agregador do mesmo feed,
   "ETH / USD", 8 casas. Não há defeito ali, e registro isto para a próxima
   sessão não refazer a suspeita.

2. **Não consegui fixar a ordem dentro do bloco, e o RPC público se contradiz.**
   `getAssetPrice` honrou a etiqueta de bloco (US$ 2.584,2400 no 906 →
   US$ 2.579,4415 no 907, queda de 0,1857% — que é exatamente o 0,1838% que
   faltava). Mas `latestRound()` no agregador devolveu a MESMA rodada 83390 em
   905, 906, 907 e 908, e `eth_getLogs` naquele bloco não trouxe nenhum
   `AnswerUpdated` nem `NewTransmission` daquele endereço (só um, de
   `0xeb3ad439…`, na transação 499 — depois da liquidação, e não é fonte de
   nenhuma das 15 reservas). As duas leituras não podem estar certas: o nó
   público não é arquivo confiável nesta profundidade. **Buraco declarado.** Para
   fechar isto é preciso um nó de arquivo de verdade.

A mecânica provável é a óbvia — a transmissão do oráculo caiu no mesmo bloco e a
liquidação entrou atrás dela, na posição 6 — mas eu não a PROVEI, e este arquivo
existe para separar as duas coisas.

## 2026-10-07, ULTIMATO: por que um mês sem tiro, e o que de fato estava errado

Ela escreveu, depois de um mês: *"a gente está a quase um mês nisso e você só
errou, só errou, não atiramos não pegamos um alvo"*. Está certa na conta. E a
causa não era nenhuma das que eu venho consertando.

### O que eu achava, e estava ERRADO

Passei semanas consertando medições, etiquetas de log, portões e gorjeta. Duas
coisas que eu afirmei nesta mesma sessão e que a medição derrubou:

1. **"Ela perde o leilão por desenho, porque o teto do pool limita o lucro em
   US$ 1.986."** Falso. A cobertura ótima é **US$ 90.387**, que cobre dívida até
   US$ 182.000 inteira. No alvo de hoje o bot cobriria exatamente os mesmos
   US$ 1.081,95 que o vencedor cobriu, e estimaria US$ 47,12 contra os
   US$ 49,33 brutos reais. **A economia do bot está certa.** O "US$ 2.050" que
   eu publiquei saiu de eu passar a DÍVIDA onde `coberturaOtima` pede a
   PROFUNDIDADE DO POOL. Erro meu, no script, não no bot.

2. **"As duas transações do nonce 4→6 foram tiros revertidos."** Falso, e eu
   mandei ela conferir no basescan duas vezes. Buscadas por busca binária em
   `eth_getTransactionCount` e lidas nos recibos: as SEIS transações da carteira
   foram **SUCESSO**, e as de nonce 4 e 5 gastaram 3,67M de gás cada — são
   deploys de contrato. **O bot nunca atirou nenhuma vez**, e o nonce 6 está
   inteiramente explicado por instalação.

### O defeito de verdade: a antecipação estava ligada na causa errada

`atirarAntesDoCruzamento` — a única porta que manda uma transação ANTES da
posição ficar liquidável, que é a única forma de chegar no bloco certo — decide
por `blocosAteCruzar`, que vem de `deriva.ts`: **a projeção por JURO.**

O log de produção imprime, em TODA linha: `chegandoPorJuro: "nenhuma
projetável"`. E este arquivo já tinha medido que o juro é **9.000x pequeno
demais** para derrubar uma posição.

Ou seja: a máquina de antecipação existia, estava completa, testada, e ligada na
única das três causas que nunca produz alvo valioso. Por isso o bot passou um
mês vendo alvos e nunca disparando.

O conserto é `atirarNaEscritaIminente`, e a aposta dela é defensável porque
**não prevê o mercado — prevê o oráculo correr atrás de um movimento que JÁ
ACONTECEU.** Quando o log diz `mercado 0,3899% abaixo do oráculo`, essa
distância é fato medido; o oráculo escreve a partir de ~0,151% e a escrita fecha
até 0,2216% (p90 medido em 7 dias). Se o que falta ao alvo cabe nesse salto, a
transação mandada agora chega NO bloco da escrita.

Conferido contra o alvo real de hoje, e é o teste que guarda a regra:
`mercado 0,3899% + alvo a 0,1838%` → **ATIRA**. Era US$ 49,33.

E os saltos medidos (`SALTO_P50_PCT`, `SALTO_P90_PCT`, `SALTO_MAX_PCT`) viviam
só no comentário de `DESVIO_TIPICO_PCT` — o que os tornava inutilizáveis pelo
código, e é por isso que esta regra nunca pôde existir. Medição que não é
constante de código é medição que não trabalha.

### E a segunda metade, que é o que torna a primeira pagável

Um tiro especulativo paga a gorjeta MESMO revertendo. Então a gorjeta decide
quantas tentativas o saldo aguenta. Medido em 2026-10-07, 15 blocos recentes da
Base, cobertura 100%, 90 amostras das seis primeiras posições de cada bloco:

    as seis primeiras posições juntas:  p50 0,0150 gwei  p90 0,1366  p99 1,9950
    o vencedor do alvo de US$ 49,33:        0,046688 gwei, custo total US$ 0,12
    o que o bot paga:                       2,84 gwei

**Ela pode pagar 19x o p90 da frente do bloco e 61x o que o vencedor pagou.** O
diagnóstico de "leilão perdido" estava errado nos dois sentidos: ela não é
superada no lance — ela nunca entrou no leilão. E pagar 2,84 gwei não ganhava
nada a mais; só reduzia as tentativas:

    2,84 gwei -> US$ 6,71 por errada -> a carteira aguenta   6
    0,30 gwei -> US$ 0,71 por errada -> a carteira aguenta  57
    0,015 gwei-> US$ 0,05 por errada -> a carteira aguenta 866

`GORJETA_DA_FRENTE_GWEI = 0.3` é 2,2x o p90 da frente e 6,4x o que o vencedor
pagou — folga para ganhar — e só se aplica ao tiro ESPECULATIVO. Em posição já
liquidável o teto não entra: ali o alvo é certo e perder por lance seria perder
dinheiro na mesa.

### O tamanho do alvo, finalmente calculado

    BOLO DE BÔNUS da Base, 30 dias, cobertura 99,9%:  US$ 41.967/mês
      Morpho Blue  US$ 34.009 (81%)  <- o bot não olha
      Aave V3      US$  5.155 (12%)  <- o único que ele olha
      Compound V2  US$  2.803  (7%)

    A meta de R$ 10.000/mês = US$ 1.845 = 4,40% do bolo inteiro
    São 37 tiros/mês a US$ 49, ou 9 a US$ 200, de 583 que pagam o próprio gás

Não é fantasia. Mas são 6,4% dos alvos que pagam o gás, num lago de 12%.

### O que NÃO está resolvido, e é a próxima obra

**O alvo de hoje não estava na brasa.** Precisava de 0,1838% e o log, cinco
blocos antes, dizia que o mais perto que paga o gás estava a 0,3733%. Com a
brasa cortando em 14,51%, se o bot o tivesse lido ele seria o PRIMEIRO da fila.
E o devedor não emite `Borrow` há 20,8h (cobertura 99,2%), então só o cache de
3 anos o acha. **A regra nova não serve para nada se o alvo não está na lista** —
e é esse o próximo buraco, não a gorjeta.

**E a janela no Morpho continua sem resposta:** 32 liquidações em 5 dias, mas só
9 mediíveis (cobertura 28,1%), 2 delas com janela. 22% contra os 25,6% da Aave —
parecido, mas 28% de cobertura não decide nada.
