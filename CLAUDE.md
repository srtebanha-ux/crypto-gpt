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

### 2026-10-07, 11:40: o tiro especulativo disparou — e o portão seguinte o barrou

Primeiro `[NA ESCRITA]` da história do projeto, e o log mostrou o defeito
seguinte na mesma respiração:

    [NA ESCRITA]          devedor 0x9e70b090, falta cair 0,061721%,
                          mercado já caiu 0,1953%
    [ANTES DO CRUZAMENTO] a medição reverteu, como tinha de reverter
    [ESCOLHA]             lucros ["V1: 0", "V2: 0"]
    ...e nenhum tiro saiu.

A medição roda por `eth_call` ANTES da posição cruzar, e a Aave recusa posição
saudável: **ela reverte sempre e devolve zero, por construção.** E
`decidirTiro` exige lucro acima de zero. Então o caminho que existe para atirar
antes do cruzamento era barrado por exigir uma prova que só existe DEPOIS
dele — a mesma espera que faz o bot chegar tarde, voltando por outra porta.

Para o alvo especulativo o lucro passa a vir de `lucroEstimado`, que é a curva
do pool medida em `venda.ts` aplicada à dívida que a própria Aave devolveu.
Conferido contra o alvo real de hoje: dívida US$ 2.163,90 → estimativa
US$ 47,12, e o bônus bruto realizado pelo vencedor foi US$ 49,33.

Sem dívida conhecida não se estima nada: fica a medição e o portão recusa com
motivo, em vez de um zero inventado.

### 2026-10-07, 12:15: a POEIRA liquidável era um laço infinito

O `[NAO MANDEI]` recém-criado pagou por si na primeira hora. Ele apontou
`0x12314a83c193f7b5aeabdbd69da59d328329d111`, que aparecia no log desde 12:06 com
os dois contratos revertendo por um motivo que **não** era "ainda não cruzou".

Lido na rede, no mesmo minuto:

    saúde    0,96540468   >>> LIQUIDÁVEL
    dívida   US$ 0,00     garantia US$ 0,01

É poeira. Uma posição assim fica **permanentemente liquidável e
permanentemente impossível**: a medição reverte porque não há o que liquidar, e
a saúde nunca volta acima de 1. O bot tentava nela em TODO ciclo.

E o contador de falhas por alvo não a barrava, porque ele só incrementa no
caminho do ENVIO — e aqui nunca se envia (`medicoes.length === 0` dá `continue`
antes). Laço infinito, enchendo o log e escondendo alvo de verdade.

O corte não é um piso novo: é `lucroEstimado`, que já existe, já é líquida do gás
e já traz a curva do pool medida em `venda.ts`. Se ela não devolve lucro
positivo, não há tiro possível ali por preço nenhum. Conferido nos dois extremos:

    dívida US$    0,00  ->  renderia −US$ 0,30   poeira
    dívida US$ 2.163,90 ->  renderia  US$ 47,12  vale o tiro

Inventar um piso aqui seria a quarta vez, neste arquivo, que eu sincronizo uma
regra na mão em dois lugares.

**E o `[NAO MANDEI]` existe porque os dois `continue` eram mudos.** Se
`CACA_ENVIAR` não fosse 1, o bot media, aprovava e não mandava — com o log
IDÊNTICO a "não havia alvo". Foi o disjuntor mudo outra vez, no mesmo caminho.
Custo medido do silêncio: eu pedi a linha `[BOTÕES]` três vezes para descobrir
de fora o que aquela linha podia ter dito sozinha no instante exato.

## 2026-10-07, 12:28: O BOT ATIROU. Quatro tiros reais, e quatro defeitos no log

Depois de um mês, o primeiro tiro. Quatro, na verdade, no alvo
`0x9e70b090f9f7e367c81ff54265b412e483d444f6`:

    0x5f02a9fc  0x12b23852  0xb1d62c16  0x17f9fa27

Todos pelo caminho novo (`[NA ESCRITA]`), todos com gorjeta de **0,300 gwei** —
o teto medido — e `seEuPerderCusta: 0.000224 ETH (aguento mais 70)`. As quatro
juntas custaram **0,000204 ETH (~US$ 0,53)**. O desenho da gorjeta funcionou
exatamente como medido: a 2,84 gwei esse mesmo gasto seria 6 tentativas.

As quatro reverteram, e o log mostrou quatro defeitos — três meus, criados nas
duas horas anteriores.

### 1. Dois tiros no MESMO bloco, no mesmo alvo

`0xb1d62c16` e `0x17f9fa27` saíram para o bloco **52293405**, um segundo depois
do outro. O segundo era reversão garantida com o gás pago.

A causa: com a postura 'dedo no gatilho' o ciclo lê a cada **200ms** e o bloco
da Base dura **2s** — o mesmo bloco é visitado várias vezes. E o próprio log já
dizia `"dois tiros no mesmo alvo = o segundo reverte com o gás pago"`, mas essa
regra só valia DENTRO de um ciclo, entre os dois contratos. **Entre ciclos do
mesmo bloco ela não existia** — regra em dois lugares, e o segundo lugar nunca
foi escrito. É a REGRA 3 me pegando pela quarta vez neste arquivo.

`ultimoTiroNoBloco` é marcado no instante em que o tiro SAI, não quando o recibo
volta: o recibo leva segundos e o bloco dura dois.

### 2. A gravação do cache passou a disputar o mesmo arquivo temporário

    [CACHE] NÃO regravei. ENOENT: rename '/app/data/devedores.json.tmp' ->

Dois tiros resolveram juntos, e eu tinha acabado de fazer o placar gravar a cada
tiro. O temporário era `${caminho}.tmp`, o MESMO para todas as gravações: a
segunda não achou o arquivo porque a primeira já o renomeara.

Perder uma gravação é o menor dos males. **Duas escritas concorrentes no mesmo
arquivo podem se intercalar, e o `rename` publica um JSON cortado em cima de
1.156 dias de história.** `pareceCache` barraria na leitura seguinte — mas o
histórico já estaria perdido.

Dois consertos, porque são duas causas: nome **único por gravação** (cada uma
tem o seu arquivo, e o `rename` continua atômico) e uma **fila** em
`regravarCache` (serializar custa nada: 20ms com 50 mil devedores, medido).

### 3. A escalada de lance não serve para aposta

O log subiu o lance de 40% para 80% do lucro em quatro reversões, dizendo "subo
o lance no próximo". A escalada existe para responder *"perdi a corrida por
lance"* — e uma aposta na escrita do oráculo que não se realizou **não é corrida
perdida**: a posição simplesmente não cruzou. Nenhum lance evitaria aquelas
reversões, e cada ponto de gorjeta encarece a próxima tentativa.

Agora `perdasSeguidas` só sobe em tiro sobre posição JÁ liquidável.

### 4. E a frase culpava a pessoa errada

`[ERROU] A transação reverteu — quase sempre porque outro liquidou antes` saiu
nas quatro. É verdade para tiro em posição já liquidável e **falso** para a
aposta: ninguém chegou antes porque não havia o que levar. Etiqueta que não
descreve o evento, no lugar exato que explica o gasto — o mesmo defeito que este
arquivo persegue desde a primeira página, agora na linha que eu criei hoje.

A frase passou a seguir o TIPO do tiro.

### E o teste que quebrou, pela razão certa

`gravarCache escreve no temporário e só depois renomeia` tinha o literal
`.tmp` cravado. Reescrito para afirmar a REGRA — cria a pasta, escreve num
temporário dentro dela, e renomeia **esse** temporário — mais um caso novo que
prova que duas gravações concorrentes não disputam o mesmo arquivo.

### 2026-10-07, 13:49: 7 de 7 reverteram, e a conta que eu devia ter feito ANTES

`gas: 0.015008 ETH` contra os 0,015821 do começo: **0,000813 ETH (~US$ 2,10) em
7 tiros, 0 acertos.** O teto de gorjeta funcionou (US$ 0,30 por errada em vez de
US$ 6,71), a trava de 4 por alvo/hora funcionou, o `[PULEI]` funcionou. O que
não funcionou foi a **aritmética da aposta**, e eu não a tinha feito.

    o oráculo do ETH escreve 121,7 vezes/dia (7 dias, cobertura 92,9%)
    a Base faz 43.200 blocos/dia
    -> uma escrita a cada 355 blocos, ou 11,8 minutos

A transação especulativa vale por UM bloco. Então a chance **cega** de ela cair
no bloco de uma escrita é 1/355 = **0,282%**. E com US$ 0,30 por errada:

    prêmio US$   1,80  ->  precisa acertar 14,3%   (51x o acaso cego)
    prêmio US$  20,00  ->  precisa acertar  1,5%   ( 5x o acaso cego)
    prêmio US$  49,33  ->  precisa acertar  0,6%   ( 2x o acaso cego)
    prêmio US$ 106,00  ->  precisa acertar 0,28%   (= o acaso: paga sozinho)

**O bot apostou sete vezes num prêmio de US$ 1,80.** Isso perde dinheiro por
desenho, por boa que seja a previsão. O conserto não é afinar o limiar no
escuro — é `APOSTA_MINIMA_USD`, um piso de prêmio. Conferido nos dois alvos
reais do dia: o que gastou os 7 tiros rende US$ 1,57 e **não aposta mais**; o de
US$ 49,33 das 10:32 rende US$ 47,12 e **aposta**.

**O piso é ESCOLHA, não medição, e está escrito como tal no código.** 0 de 7 não
limita a taxa de acerto real (pela regra de três o teto de confiança ainda é
~43%). US$ 20 exige que a aposta seja 5x melhor que chutar — defensável porque
ela não é cega, mas é hipótese. `CACA_APOSTA_MINIMA_USD=0` volta ao de antes.

#### E o erro de raciocínio por trás de tudo isso, que é meu

`DESVIO_TIPICO_PCT = 0.10` saiu do **menor salto observado entre escritas**. Eu
o usei como **o desvio que faz o oráculo escrever**. São duas perguntas
diferentes, e trocar uma pela outra é o mesmo erro que este arquivo registra
cinco vezes na regra de concentração — agora com unidade de porcentagem.

O log de 12:44 mostra que o 0,10% não dispara escrita nenhuma: o desvio subiu de
0,1566% para 0,1853% em **seis segundos** sem nenhuma escrita resetá-lo. Se
0,10% fosse o gatilho, teria resetado na primeira leitura.

**O que fecharia isto de verdade** e não está medido: a relação entre o desvio
fora da corrente e o tempo até a próxima escrita. Precisa de histórico de preço
fora da corrente alinhado aos eventos `AnswerUpdated` — não dá para fazer daqui
com o que temos. Até medir, o piso de prêmio é o que impede a aposta de sangrar.

### 2026-10-07, 17:04: OITO poeiras de uma vez — a REGRA 3 pela QUINTA vez

O log trouxe oito devedores diferentes, todos no bloco **52301641**, todos com
`[NAO MANDEI] Nenhum contrato produziu medição utilizável`. Lido na rede, o
primeiro deles:

    0x8c095dd766b5a0936da8b3b2d8a6e68052bff18d
    saúde 0,998653   LIQUIDÁVEL
    dívida US$ 0,00  garantia US$ 0,00  renderia −US$ 0,30

É poeira — **e o filtro que eu escrevi às 12:15, cinco horas antes, devia
tê-la barrado.** Não barrou.

Porque `caidos.push` acontece em QUATRO lugares, e eu consertei os do laço da
brasa. O quarto é a **varredura completa**, que tem o seu próprio
`if (queda.isZero()) caidos.push(...)` — sem filtro nenhum. E como ela passou a
rodar a cada 15 minutos em vez de 60 (`CACA_MINUTOS_COMPLETA=15`), despejou oito
de uma vez.

**É a REGRA 3 deste arquivo me pegando pela quinta vez**, e a quinta foi no
conserto da quarta: *"uma regra em dois lugares é a mesma regra; se dois lugares
calculam a mesma coisa, junte num só em vez de sincronizar na mão"*. Eu escrevi
um `if` no laço em vez de uma função, e o gêmeo continuou solto.

Agora é `ehPoeira(dividaUsd)` em `perdidas.ts`, e os dois caminhos a chamam. Um
teste exige que ela e `lucroEstimado` **concordem em toda dívida** — se
divergirem, voltaram a ser duas regras.

E a varredura passou a DIZER quantas descartou (`[POEIRA] A varredura achou
liquidável impossível e não mandou para a fila`). Foi a ausência dessa linha que
deixou as oito entrarem sem ninguém notar entre 12:15 e 17:04 — silêncio não é
resposta, no arquivo que diz isso desde a primeira página.

Conferido com a função de verdade:

    dívida US$    0,00  ->  renderia −US$ 0,30   POEIRA (os dois casos de hoje)
    dívida US$   10,00  ->  renderia −US$ 0,08   POEIRA
    dívida US$ 2.163,90 ->  renderia  US$ 47,12  vale a fila

## 2026-10-08: 18,7 horas de placar — a LEI do projeto confirmada, e o meu piso errado

O log trouxe o primeiro placar longo, e dois números decidem tudo:

    [POEIRA]  quantas: 361        <- o conserto de ontem achou 361, não uma
    desdeOBoot  18,7 horas
      aconteceram      3
      valiamAPena      1
      lucroQuePassou   US$ 11,59
      ondeEuEstava     { brasa: 1 }   <- o bot ESTAVA olhando

Varri as três na corrente, cobertura 87,0% (94 de 108 janelas de 312 blocos), e
medi a saúde **dois blocos antes** de cada uma:

    0xdc9dd1c7  bloco 52307770  dívida US$   0,87  renderia −US$ 0,28  TINHA JANELA
    0xbd34e36b  bloco 52330850  dívida US$ 539,88  renderia  US$ 11,59 JANELA ZERO
    0x99772b56  bloco 52332795  dívida US$   0,31  renderia −US$ 0,29  TINHA JANELA

**É a lei deste arquivo, medida pela terceira vez e com dados de hoje:** *se vale
dinheiro, é levada no mesmo bloco; se sobra tempo, é porque não vale nada.* As
duas com janela eram poeira. A única que pagava — HF 1,00168552 nos blocos
52330848 **e** 52330849, faltando 0,1683% — foi liquidada no 52330850.

### E O PISO QUE EU PUS ONTEM BARROU EXATAMENTE ELA

`APOSTA_MINIMA_USD = 20` recusou um prêmio de **US$ 11,59** que faltava 0,1683%
— dentro do salto p90 de 0,2216%, o caso EXATO para o qual
`atirarNaEscritaIminente` existe. Vinte e quatro horas depois de criar a regra,
o piso que eu escolhi para protegê-la a desligou.

**Um piso que barra a única oportunidade do dia não protege nada: desliga a
estratégia com outro nome.** US$ 10 agora, e o teste guarda os dois lados — não
pode cair abaixo de US$ 5 (acerto exigido acima de 5,7%) nem passar de US$ 11,59
(o caso real medido). O custo é limitado e conhecido: a trava de 4 tentativas
por alvo/hora deixa o gasto em no máximo **US$ 1,20 por hora** com alvo ao
alcance, contra um prêmio de US$ 11,59.

### O TETO DO CAMINHO DA AAVE — e eu publiquei ele 9,0x PEQUENO DEMAIS

Vinte minutos antes desta linha eu escrevi aqui: *"ganhando 100% das liquidações
que valem a pena na Aave da Base, o caminho atual chega a R$ 2.419/mês — um
quarto da meta"*. **Errado por 9,0 vezes**, e a medição certa estava sendo
impressa pelo próprio bot, no log de boot que ela tinha acabado de colar.

O que eu fiz: peguei **1 oportunidade em 18,7 horas** de placar, multipliquei
por 30 dias e por US$ 11,59. Uma observação virando teto mensal.

O que o censo do bot diz, 46,3 dias, 40 janelas, **0 falharam (cobertura 100%)**:

    aconteceram            208 no total, 4,5 por dia, ~135 por mês
    naSUAFaixa             55 de 208 — entre US$ 0,96 e SEM TETO
    lucroQuePassouNaFaixa  US$ 6.168,41 em 46,3 dias
                           = US$ 3.996,81/mês  =  R$ 21.663
                           = 36 migalhas/mês, média US$ 112,15
    asTresMaiores          US$ 1.771,48 | US$ 1.488,49 | US$ 545,61

    a meta dela:  R$ 10.000 = US$ 1.845/mês = 46,2% disso = 16 das 36 migalhas

Então o caminho da Aave **não** é um quarto da meta: é **2,2x** a meta, e a
pergunta deixa de ser "dá para chegar lá?" e passa a ser "quantas das 36 a gente
ganha?". O log do próprio bot avisa, e vale repetir: isso é OPORTUNIDADE que
passou, não renda — cada uma ainda exige ganhar a corrida do bloco.

**Os dois erros meus são a regra 4 e a regra 2 deste arquivo, juntas:**
extrapolei de 18,7 horas (regra 4) quando o histórico de 46 dias estava
disponível, e calculei de novo uma grandeza que o repositório **já media e já
imprimia** (regra 2). A média de US$ 11,59 que eu usei era a de UMA liquidação;
a média real da faixa é US$ 112,15 — 9,7x maior, porque as grandes carregam a
soma e uma janela de 18 horas não as vê.

E a decisão sobre o Morpho muda de natureza: ele continua sendo 81% do bolo com
bônus de 9–16% nos mercados de LLTV ≤ 77%, mas **deixa de ser necessário para a
meta.** Virou escolha de ampliar, não de sobreviver.

## 2026-10-08: "por que os outros estão pegando nossos alvos?" — não é lance

Ela perguntou isso depois de 7 tiros revertidos. A resposta tem duas metades, e
as duas estão medidas; nenhuma delas é lentidão nem lance baixo.

**1. Todo alvo que paga é levado DENTRO do bloco em que o oráculo escreve.**
Os dois únicos alvos valiosos que este projeto mediu, conferidos bloco a bloco:

    0x6b950f30  US$ 49,33   HF 1,00184180 em 52289905 E 52289906  ->  liquidada em 52289907
    0xbd34e36b  US$ 11,59   HF 1,00168552 em 52330848 E 52330849  ->  liquidada em 52330850

Em nenhum dos dois existiu um bloco em que a posição estivesse liquidável e
disponível. Quem lê o estado depois do bloco minerado não perde por milissegundos
— perde porque o instante que ele espera nunca existe. É a terceira confirmação
da lei deste arquivo, agora com dinheiro em cima.

**2. Nós não somos superados no lance. Nós nunca entramos no leilão.**

    o vencedor do alvo de US$ 49,33 pagou   0,046688 gwei  (US$ 0,12 total)
    a frente de um bloco da Base, p90        0,1366 gwei
    o que a carteira dela aguenta pagar      2,84 gwei      = 61x o vencedor

O diagnóstico de "leilão perdido" que eu carreguei por semanas estava errado nos
dois sentidos: ela pode pagar 19x o p90 da frente do bloco, e pagar mais não
compra nada — só reduz o número de tentativas que o saldo aguenta.

**Então "ser melhor que qualquer bot" tem um significado técnico único:** estar
DENTRO do bloco da escrita do oráculo. É o que `atirarNaEscritaIminente` tenta,
apostando no oráculo correr atrás de um movimento que JÁ aconteceu. Não é ler
mais rápido nem pagar mais alto — essas duas portas estão medidas e fechadas.

## 2026-10-08, 12:39: o log diz "outro chegou antes" sobre tiro que NINGUÉM disputou

Três defeitos no log de hoje, e o primeiro é a REGRA 3 pela **sexta** vez.

### 1. A frase do placar culpava a concorrência pelos sete tiros especulativos

    tiros: "7 de 7 reverteram: outro chegou antes. É corrida perdida por pouco,
            não falta de alvo."

Os sete eram `[NA ESCRITA]` — aposta na escrita do oráculo. Ninguém chegou
antes: a posição nunca cruzou e não havia o que levar. **Em 07/10 eu consertei
exatamente esta frase na linha `[ERROU]`** — "a frase passou a seguir o TIPO do
tiro", está escrito acima neste arquivo — **e deixei a gêmea solta no placar**,
porque o placar não sabia o tipo. Consertei uma ponta e a outra continuou
publicando o diagnóstico invertido, em letras maiores, na linha de resumo que
ela lê primeiro.

As duas reversões pedem conserto **oposto**: corrida perdida pede lance maior ou
ciclo mais curto; aposta que não cruzou pede alvo mais valioso, e lance maior só
encarece a próxima. A frase mandava arrumar a coisa errada.

`PlacarDosTiros.especulativos` conta, atravessa o disco (campo opcional: cache
velho continua servindo, e um valor adulterado é limitado ao total) e a frase
segue o tipo, com três formas — todas aposta, mistura, todas corrida.

### 2. "1 alvo vale, e vale US$ 0"

    1%: 2 alcanço/1 valem (US$ 0, maior US$ 0 a 0.30% [par MEDIDO])

O contador está **certo** — `quantosValem` só sobe com lucro acima de zero — e o
`toFixed(0)` apagou um prêmio de centavos. O resultado lê como contradição, e
quem lê não consegue separar "arredondou" de "o contador quebrou": as duas pedem
ações opostas. Abaixo de US$ 10 as casas decidem se existe alvo. O teste afirma
a REGRA (se o degrau diz que alguém vale, o dólar publicado é maior que zero) e
três literais antigos foram corrigidos — um deles escondia **US$ 1,72 atrás de
"US$ 2"**.

### 3. Vinte e duas linhas de `[POSTURA]` em oito minutos

`dormindo → atento → dormindo`, sem parar, entre 12:29 e 12:36. O limiar do
'atento' é 0,06% (`DESVIO_DE_ESCRITA × 0,6`) e o ruído do mercado passeia em
volta de 0,06%.

**O comportamento está certo e NÃO foi mexido.** `dormirDeOlho` fatia o sono e
olha o mercado entre as fatias, acordando no instante da troca — dormir não
atrasa nada. Subir o limiar ou colocar histerese atrasaria o ARMAR, que é o lado
errado de errar e o que ela proibiu desde o começo. O que custa é o log:
vinte e duas linhas iguais enterram o evento de verdade. Agora a oscilação é
contada e sai junto da próxima linha (`oscilouAntes`), com uma exceção que não
se discute: **qualquer transição que envolva 'dedo no gatilho' sai sempre** — é
a postura em que o tiro acontece. E o retorno da função é o mesmo com log ou sem
log, senão eu teria trocado comportamento por cosmética.

### E um defeito que eu fui medir e NÃO existia

O log tem dois pisos, e pareciam a mesma regra em contradição:

    [BLOCO]   "44036 devem menos de US$ 33.70 e não pagariam o próprio gás"
    [PLACAR]  pisoUsado "US$ 0.96 — contado contra o piso da faixa de tiro de agora"

Rodado com as funções de verdade: `lucroEstimado(US$ 33,70)` = **US$ 0,44**. São
duas perguntas diferentes (seleção em dívida, tiro em lucro) e o piso da seleção
é o MAIS FROUXO dos dois — o lado seguro: admite alvo que o portão do tiro
depois recusa, gastando vaga de vigília, e não deixa de fora nenhum que ele
atiraria. **Não é defeito, e registro para a próxima sessão não "consertar"**
uma das duas pontas e criar o desencontro que hoje não existe.

## 2026-10-08, 13:06: o alvo ESTAVA na memória. Foi a leitura

A pergunta que travou a estratégia desde 07/10 foi respondida por uma variável
de ambiente, em uma linha, sem deploy de ferramenta e sem varredura:

    [PROCURA] 0x6b950f306f987ff8fb9808886977ca2ef3af2c28:
      "está na memória, visto no bloco 52076237, via long.
       Então se não apareceu na brasa, foi a LEITURA que falhou"

O alvo de US$ 49,33 **estava** na lista de 61.771 desde o bloco 52076237, com a
via já resolvida. Não é buraco de cobertura do cache. A hipótese que eu carregava
— "só o cache de 3 anos o acharia, e talvez não esteja lá" — está morta.

### E o que o `[PROCURA]` NÃO dizia, que é o conserto

"Foi a leitura que falhou" não diz QUAL leitura, e são três camadas com três
consertos diferentes e três preços:

    brasa             233 vagas      lida a cada ciclo
    lista quente    1.443 esperando  LÊ SÓ 250 por ciclo (CACA_TETO_QUENTE)
    completa       61.771            a cada 15 min

Afirmar qual das três barrou, sem medir, seria exatamente o erro que este
arquivo registra mais vezes — eu afirmando o mecanismo sem seguir o valor. Então
o `[PROCURA]` passou a sair TAMBÉM na varredura completa, dizendo a camada, a
`queda` que está valendo, a dívida e a via. Com isso a resposta deixa de ser
inferência minha:

- aparece na BRASA com queda pequena e o bot não atirou → não é leitura nenhuma,
  é um portão do tiro;
- aparece na LISTA QUENTE → é o teto de 250, e o conserto é o teto;
- FORA das duas → é a varredura de 15 minutos;
- sem medição na varredura → posição fechada, ou a leitura dele falhou no ciclo.

### E a frase que afirmava "não teve" sobre DOIS SEGUNDOS

No mesmo boot, duas linhas discordando sobre o mesmo mundo:

    [PLACAR]   janela: "blocos 52337728–52337728"   <- UM bloco
               "Não foi velocidade nem cobertura: não teve."
    [MERCADO]  aUltima: "15 minutos atrás"

O censo do próprio bot mede 209 liquidações em 46,3 dias com cobertura 100% =
4,51/dia. A Base faz 43.200 blocos/dia, então **uma liquidação a cada ~9.580
blocos**: um bloco tem 0,01% de chance de conter uma. Concluir "não teve" dali é
publicar como achado o silêncio de uma janela onde o silêncio era o resultado
esperado — ausência com cara de resposta, na linha que existe para medir
ausência.

`BLOCOS_POR_LIQUIDACAO = 9.580` **não é número meu**: sai da linha `[MERCADO]`
que o bot imprime em todo boot, e remede quando o censo remedir. A frase agora
mostra a conta (`eu esperaria 0.000`) para quem lê poder discordar dela, e manda
a pergunta para o acumulado desde o boot, que é quem pode respondê-la.

Rodado contra os valores reais deste log, as três frases novas:

    1 bloco      -> "é CURTA demais para concluir… eu esperaria 0.000"
    450 blocos   -> "… eu esperaria 0.047"
    43.200       -> "não teve"   (a regra não é nunca concluir)

### 2026-10-08, 13:14: o conserto estava NO AR e a frase errada saiu de novo

O log trouxe o `US$ 0.00` novo funcionando nos degraus — e a mesma frase que eu
tinha acabado de consertar:

    tiros: "7 de 7 reverteram: outro chegou antes. É corrida perdida por pouco…"

**O defeito é meu, dentro do conserto dele, e é a assinatura deste arquivo.**

`especulativos` é lido do cache. Os sete tiros foram contados em 07/10, antes do
campo existir. O arquivo não tem o campo, e eu fiz a ausência virar **zero**.
`0 >= 7` é falso, `0 > 0` é falso — então a frase caiu no ramo final e afirmou,
com confiança, exatamente o que o conserto existia para impedir. **Para sempre,
porque aquele cache nunca vai aprender o tipo deles.**

Campo ausente virando zero, e o zero publicado como fato positivo. É a mesma
forma que `lucroCru = 0n` sendo lido como "não mediu", que o `pisoUsado` caindo
no default, que a cobertura dizendo 100% com todas as janelas falhando. Está
escrito na primeira página deste arquivo e eu a cometi no parágrafo seguinte ao
que a descreve.

**`especulativos` agora é `number | null`, e `null` quer dizer "não registrei".**
A frase, rodada contra o cache REAL dela (os 7 tiros como estão no volume):

    7 de 7 reverteram, e eu NÃO REGISTREI o tipo deles — foram contados antes de
    eu passar a separar aposta de corrida, então não sei se ninguém chegou antes
    (aposta que não cruzou) ou se perdi a corrida. Os dois pedem conserto oposto,
    e os próximos tiros saem com o tipo.

Quatro regras que os testes guardam, porque cada uma é um jeito de o `null`
virar número outra vez:

    ausente no disco        -> null          (o caso real dela)
    zero REGISTRADO         -> 0             e aí "outro chegou antes" é a resposta certa
    campo torto ('1', -3, 1.5) -> null       não sei é melhor que sei errado
    null NÃO vai ao disco                    a ausência já diz "não registrei"
    tiro novo em cima de null -> adota 0 e passa a contar

E o teste que eu mesmo tinha escrito duas horas antes — *"cache gravado antes de
2026-10-08 não tem o campo: zero, não NaN"* — **afirmava o default errado**. Era
ele que deixava a frase passar. Reescrito para afirmar `null`.

**A lição, e ela é nova:** eu testei o round-trip do campo NOVO e não testei o
round-trip do cache QUE EXISTE. O caso que importava era o único que não dava
para inventar — ele estava gravado no volume dela desde ontem.

## 2026-10-08, 13:44: o `[PROCURA]` fechou a pergunta de 07/10, e a resposta era a IDADE DE UM NÚMERO

A linha nova respondeu:

    [PROCURA] 0x6b950f30…: precisa cair 8.8937%, dívida US$ 1082.02, via long
              — BRASA (das 233 vagas): lido a cada ciclo

O alvo de US$ 49,33 está na **BRASA**, lido a cada ciclo. (A dívida é
US$ 1.082,02, a metade que sobrou do que o vencedor cobriu — a posição segue
aberta.) Então em 07/10 a leitura ACONTECIA. O que falhou foi outra coisa.

### `menorMargem` — o número que decide a postura — tinha 15 MINUTOS de idade

No log de hoje, `maisFragilA` saiu **idêntico** em oito avaliações de postura:

    13:31  1.2706%      13:39  1.2706%      13:43  1.2706%
    13:32  1.2706%      13:41  1.2706%      13:44:29  <- varredura completa
    13:34  1.2706%      13:42  1.2706%      13:44:57  0.3559%   <- mudou aqui

Treze minutos de um valor congelado enquanto a brasa era lida a cada 8 segundos.
A causa: `repartirPorFragilidade` é chamada em **um** lugar, e esse lugar é
`if (varredura === 'completa')` — de 15 em 15 minutos.

**E não é cosmética: é a decisão.** Rodado com `posturaPorMargem` e os números
reais daquele minuto:

    mercado 0,3705% + maisFragilA 1,2706% (velho)  ->  'atento'        (1000ms)
    mercado 0,3705% + maisFragilA 0,3559% (fresco) ->  'DEDO NO GATILHO' (200ms)

O mesmo mercado, duas posturas, e a diferença é a idade do número. Às 13:45:43 o
log mostra ele armando `dedo no gatilho` — **porque a varredura tinha acabado de
rodar.** Treze minutos antes, não teria.

E fecha o buraco que este arquivo deixou aberto em 07/10: `maisFragilA: 0.3733%`
era número velho; a posição a **0,1838%** estava na brasa e era lida. O alvo não
estava invisível — o número que decide o ritmo é que não aprendia dele.

A postura agora lê o mínimo da brasa AO VIVO, com os mesmos cortes da varredura
(imune não decide o ritmo; poeira não decide o ritmo, pela `ehPoeira` que já
existe; liquidável de verdade conta). `null` não sobrescreve — brasa vazia não é
resposta sobre o mercado. E o `[POSTURA]` passou a imprimir **a idade do
número** ao lado dele (`lido há 8s`), porque foi exatamente por não ter isso que
eu li o `0.3733%` de 07/10 como se fosse o estado daquele instante.

### E os SETE TIROS foram APAGADOS do disco. Pelo write do boot

    13:06   vindoDoDisco: "7 tiro(s) contados antes deste boot"
    13:34   tiros: "Nenhum tiro que eu lembre… eu contei 0 tiro(s):
                    14 saíram sem eu lembrar"

Mesmo cache, sete viraram zero entre dois boots.

`gravarCache` é chamada em **dois** lugares. `gravarAgora` monta o objeto com
`placar: placarParaCache(tiros)` — e tem um comentário dizendo "o placar vai em
TODA gravação". **A gravação do BOOT não levava o campo.** Ela reescreve o
arquivo inteiro, então o campo desaparecia do disco; o boot seguinte começava em
zero, e a primeira `regravarCache` publicava esse zero em cima dos sete.

Reproduzido com as funções reais:

    1. como estava:                7 tiro(s)
    2. depois do write do boot:    0 tiro(s)   <- APAGADO
    3. e a regravação grava:       {"disparados":0,…}

Entre apagar e restaurar havia uma **janela**, e este arquivo já registra que o
Railway reinicia o container várias vezes por dia. Era questão de o reinício cair
ali. Caiu. **Os sete desfechos estão perdidos** — o nonce 14 prova que as
transações saíram, e o basescan tem cada uma, mas a contagem do bot não volta.

É a REGRA 3 pela **sétima** vez, e a pior forma dela: não um valor errado, um
campo **ausente** numa das duas chamadas. Nenhum teste de valor pegaria isso, e
foi por isso que passou por 1.400 testes. O teste novo lê o CÓDIGO e exige que
toda chamada de `gravarCache` carregue o placar — conferido que ele reprova a
versão de antes e aprova a de agora.

#### E o teste novo passou com `tsx` e REPROVOU em `npm test`

`import.meta.url` nem compila sob o runner deste projeto
(`node --require ts-node/register`, CommonJS): `error TS1343`. Eu rodei o
arquivo com `npx tsx --test`, vi `32 pass`, e a suíte inteira reprovou.

**Duas ferramentas, dois sistemas de módulo, e só uma delas é a que vale.**
Rodar o arquivo isolado com a ferramenta errada é a mesma classe de erro que
este arquivo persegue: eu conferi a cópia, não o original. É `join(__dirname,
…)` agora. 1.434 testes, 0 falhas no runner de verdade.

## 2026-10-08, fim: o teste que mata a CLASSE, porque ela já me pegou duas vezes

Ela perguntou: *"lembra que eu falei pra você parar de errar?"*. Lembro, e hoje
eu errei quatro vezes, três delas com a MESMA forma: **eu conferi a coisa nova e
não conferi a que já existe.**

    especulativos com default zero  -> testei o round-trip do campo NOVO,
                                       não o do cache que está no volume dela
    placar fora do write do boot    -> adicionei o campo a UM dos dois gravadores
    import.meta no teste            -> rodei com `tsx`, não com o runner do projeto

E o segundo já tinha acontecido: em 2026-10-06 a **bússola** morria a cada deploy
porque `vias` estava num gravador só. Mesma classe, campo diferente, dois dias de
distância. Prometer não repetir já falhou — então o conserto é mecânico.

`src/cacheDeDevedores.test.ts` agora lê o CÓDIGO: pega os nomes dos campos da
interface `CacheDeDevedores` (só profundidade 0 — o que se perde ao esquecer um
campo é o campo de cima inteiro) e exige que **todo** campo apareça em **toda**
chamada de `gravarCache`. Conferido nos dois sentidos que importam:

    com o código de ONTEM (placar fora do boot)   -> REPROVA, dizendo "não leva `placar`"
    com um campo NOVO que ninguém gravou          -> REPROVA nas duas gravações, pelo nome
    com o código de hoje                          -> passa

Por que lê o código e não valores: o defeito não era um valor errado, era um
campo **ausente** numa das chamadas. Nenhum teste de valor o pega — este passou
por 1.400 deles e custou sete tiros reais.

**E o que ele NÃO pega, declarado:** ele olha a PRESENÇA do campo, não o valor.
Uma gravação que escreva `devedores: {}` ou passe a variável errada passa por
aqui. Ele mata uma classe — campo esquecido num gravador — e só ela.

## 2026-10-08, 14:28: os três consertos apareceram no log — e sobrou UM buraco medido

O log dela confirma os três:

    maisFragilA  "1.3452% [lido há 4s]"   <- a idade do número, ao lado dele
                 1.1888% (varredura) -> 1.3452% -> 1.2631%   a posição andou e ele VIU
    oscilouAntes "3 troca(s) iguais caladas nos últimos 30s"
    degraus      "US$ 0.00" em vez de "US$ 0"

A segunda linha é a prova de que o conserto da postura é real e não cosmético:
entre a varredura das 14:28 e a leitura das 14:30 a posição ficou 0,16 ponto
mais segura, e o número mudou sozinho. Antes ele ficaria em 1,1888% por quinze
minutos.

### O teto da lista quente cegava 1.187 posições, e o log mediu o custo

    naListaQuente: "1437, mas LI SÓ 250 (teto CACA_TETO_QUENTE) — 1187 não foram vistos"

Medido no log DELA, com o RPC DELA:

    varredura completa  61.772 alvos | 248 multicalls
                        rede 50.742ms somados | parede 8.370ms  -> ~6x paralelo
                        => ~205ms por multicall
    ciclo da brasa         233 alvos | 1 multicall | parede 118–211ms

Os 1.437 inteiros são ~7 multicalls: **uma rodada paralela, uns 205ms.** E o
orçamento do ciclo, por `ritmoDaPostura`:

    dormindo        8000ms   cabe 39x
    atento          1000ms   cabe  4,9x
    dedo no gatilho  200ms   NÃO cabe

Então o teto cai fora quando há tempo e volta a valer no gatilho. **Não é
cautela:** a varredura 'quentes' só roda quando o mercado JÁ andou o bastante
para alcançar quem está fora da brasa — era exatamente ali que o teto cegava.
No gatilho o corte é certo por outra razão: o alvo já está identificado e a
brasa decide o tiro; gastar 205ms relendo a lista quente custa o bloco.

**E a regra está escrita como ORÇAMENTO, não como nome de postura.** A primeira
versão era `postura === 'dedo no gatilho'` — o TypeScript a recusou, e tinha
razão por outro motivo: comparar pelo nome sincroniza na mão uma conta que
`ritmoDaPostura` já faz, e se o ritmo de alguma postura mudar a comparação
continuaria respondendo a pergunta de antes. É a REGRA 3 evitada antes de
acontecer, pela primeira vez neste arquivo.

### E a etiqueta dessa mesma linha afirmava cegueira num ciclo que viu TUDO

    alvosChecados: 61772
    naListaQuente: "1437, mas LI SÓ 250 — 1187 não foram vistos neste ciclo"

As duas na MESMA linha. Numa varredura completa `aLer` é a lista inteira: os
1.437 foram lidos, dentro dos 61.772. A causa era a frase ler
`TETO_DA_LISTA_QUENTE` — o teto cravado — em vez de `corte.ficaramFora`, que é
o que de fato ficou de fora. Mesma forma do `naListaQuente: "1324 (todos
lidos)"` que este arquivo já registra: **a ternária conferia o teto em vez do
estado.** Agora ela descreve o ciclo que a imprimiu.

### O placar continua em ZERO, e isso é correto

`tiros: "Nenhum tiro que eu lembre… 14 saíram sem eu lembrar"`. Os sete foram
apagados do disco antes do conserto; ele impede a próxima perda, não desfaz
esta. O nonce 14 e o basescan continuam sendo a prova de que saíram.

## 2026-10-08, 19:20: 31 apostas, US$ 13,83 queimados, e US$ 753,48 passando na brasa

O log mais importante até agora, e os números são todos dele:

    gas        0.015008 -> 0.009541 ETH   = 0,005467 ETH (US$ 13,83) em 31 tiros
    tiros      "31 de 31 reverteram, e TODOS eram aposta na escrita do oráculo"
    desdeOBoot 4,6 horas | aconteceram 12 | valiamAPena 4 | US$ 753,48
    ondeEuEstava  { brasa: 4 }   <- o bot estava olhando as QUATRO

A frase nova funcionou (o tipo do tiro está registrado e ela não culpa mais a
concorrência), o `naListaQuente: "1470 (todos lidos nesta varredura completa)"`
funcionou. **E a estratégia está perdendo dinheiro por aritmética.**

### O ritmo de queima, rodado

    por tiro        0,000176 ETH = US$ 0,446
    por hora        0,001188 ETH = US$ 3,01
    saldo restante  0,009541 ETH = US$ 24,13 = 54 tiros
    >>> O SALDO ACABA EM 8,0 HORAS neste ritmo

### E 0 de 31 não prova nada — nem contra, nem a favor

    chance CEGA por tiro:                    0,282%  (1/355, medido em 7 dias)
    acertos esperados em 31 tiros cegos:     0,087

**Zero de 31 é exatamente o que o acaso daria.** Não condena a previsão e não
dá uma única evidência de que ela seja boa. Para somar 3 acertos seriam
necessários 213 tiros mesmo se a previsão fosse **5x melhor** que chutar — e
213 tiros custam US$ 95,01 contra um saldo de US$ 24,13. **O experimento não
cabe nesta carteira:** ela acaba antes de responder a pergunta.

### O PISO NÃO DEVIA SER MINHA ESCOLHA, e agora não é

Em 07/10 cravei US$ 20 e ele barrou a única oportunidade do dia (US$ 11,59).
Em 08/10 baixei para US$ 10 e o bot gastou US$ 13,83 em 31 apostas. **Os dois
números eram meus.** Rodado com o custo que o bot mede:

    premio      acerto exigido   vs o acaso cego
    US$   10       4,461%          15,8x
    US$   20       2,230%           7,9x
    US$   50       0,892%           3,2x
    US$  100       0,446%           1,6x
    US$  158       0,282%           1,00x   <- a fronteira
    US$  188       0,237%           0,84x   <- PAGA SOZINHO
    US$  500       0,089%           0,32x   <- PAGA SOZINHO

**`premioQueSePagaNoAcaso` sai do custo MEDIDO e da cadência MEDIDA**, e remede
quando o gás subir ou o oráculo escrever mais. Acima de US$ 158,35 apostar **às
cegas** já tem valor esperado positivo — a previsão deixa de ser premissa e
passa a ser só vantagem.

E o número que fecha o argumento: **as quatro oportunidades daquelas 4,6 horas
tinham média de US$ 188,37.** Elas pagavam sozinhas. O problema nunca foi o
prêmio das que passaram — foi o piso de US$ 10 liberando apostas em alvos que
exigiam acertar 15,8x mais que o acaso, gastando a munição que as de US$ 188
precisavam.

### E a linha que explica o gasto agora traz a conta

Eu precisei de um script para descobrir isso. Era informação que tinha de estar
no `[NA ESCRITA]`, no segundo em que o dinheiro sai:

    aApostaSePaga: "NÃO no acaso: preciso acertar 15,8x mais que chutar.
                    O prêmio que se pagaria sozinho é US$ 158,35, e este é US$ 10,40"

**Não mudei o piso.** A decisão é dela — ela já me corrigiu sobre piso uma vez,
com razão, e o custo de errar para cima (desligar a estratégia) é tão real
quanto o de errar para baixo (sangrar). O que mudou é que a decisão deixou de
ser tomada no escuro.

### "não existe perder, e sim só acertar" — a frase dela virou o portão

Ela respondeu isso quando eu pedi a decisão do piso. Não é "não tenha cautela":
é o critério, e dá para escrever em código.

**O piso deixou de ser número meu.** `premioQueSePagaNoAcaso` devolve o prêmio
acima do qual apostar **às cegas** já tem valor esperado positivo — custo por
errada vezes 355 blocos entre escritas. Acima dele a previsão deixa de ser
premissa e passa a ser só vantagem. Rodado com os números do log:

    baseFee 0,005 gwei -> errada US$ 0,424  PISO US$ 150,62
    baseFee 0,020 gwei -> errada US$ 0,445  PISO US$ 158,03   <- a do log
    baseFee 0,050 gwei -> errada US$ 0,487  PISO US$ 172,85
    baseFee 0,300 gwei -> errada US$ 0,835  PISO US$ 296,31

O piso **anda com o gás**: encarece a Base, ele sobe; o oráculo escreve mais,
ele desce. Nenhuma sessão futura precisa re-escolher — e as duas vezes que EU
escolhi, errei nas duas direções. `CACA_APOSTA_MINIMA_USD` continua mandando.

E isto não é cautela, é o contrário: **gastar US$ 0,45 num alvo de US$ 10 não é
agressão — é jogar fora o tiro que o alvo de US$ 188 precisava**, e deixar a
carteira vazia quando ele chegar.

#### E o repositório estava CERTO onde eu quase estraguei

`custoDeUmaDerrota` com o default do repositório dá 0,000224 ETH; a produção
gastou **0,000176** — o default superestima 1,27x, porque supõe que a reversão
gasta o gás da caçada inteira, e ela reverte antes.

Minha primeira reação foi corrigir `GAS_DE_UMA_REVERSAO`. **Errado.** Esse
número serve o **freio de sobrevivência** ("aguento mais N derrotas"), e ali
errar para CIMA é o lado seguro — o próprio arquivo registra que com 150k o
freio dizia "aguento 6" quando a verdade era 1.

O piso da aposta quer o oposto: errar para cima sobe o piso, barra alvo e
desliga a estratégia — foi o que US$ 20 fez em 07/10.

**Duas perguntas, dois lados seguros OPOSTOS, dois números.** É a primeira vez
neste arquivo em que manter dois é o certo, e a REGRA 3 não se aplica porque ela
manda juntar o que calcula a MESMA coisa — juntar estes faria um dos dois errar
para o lado que ele existe para evitar. `GAS_MEDIDO_DE_UMA_REVERSAO = 550.000`
(derivado dos 31 reverts; faixa 440.887–578.213 pela baseFee, e o número exato
está no `gasUsed` dos recibos) e um teste exige que ele continue MENOR que o do
freio.

#### O que este piso CUSTA, declarado

Com US$ 158 ele também barraria a oportunidade de US$ 47,12 de 07/10 (3,35x o
acaso) e a de US$ 11,59 (13,6x). São oportunidades reais que ficam de fora.

**E eu não sei se as quatro de hoje passariam**, só que a MÉDIA delas é
US$ 188,37 — e este arquivo registra, sobre o Morpho, que *"a assimetria que a
soma esconde"* é exatamente este erro. Se as quatro fossem 600/100/40/13, só
uma passaria. **Buraco declarado:** a varredura dos valores individuais na
corrente foi disparada e o RPC público não devolveu em tempo.

## 2026-10-08: "ATIRAR PRA GANHAR" — a obra do Morpho começa pela CONTA

Ela autorizou depois de eu dizer a verdade incômoda: nenhum ajuste de botão
produz "atirar e ganhar" na Aave da Base, porque está medido que os alvos
ganháveis quase não existem ali. A Aave é 12% do bolo de bônus; o Morpho é 81%.

**E começa por `src/morpho.ts`, não pelo contrato, de propósito.** A REGRA 0
proíbe pedir deploy em cima de teste unitário; construir o contrato antes de a
conta estar conferida contra a rede seria construir em cima do meu palpite.

### A primeira coisa medida CORRIGIU um número que este arquivo publicou

O bônus do Morpho **é uma fórmula do LLTV**, não uma medição:

    LIF = min(1,15 ; 1 / (1 − 0,3 × (1 − lltv)))

E eu não pedi para ninguém acreditar na minha memória: conferi contra as SEIS
medianas que o censo de 10 dias deste projeto mediu (cobertura 100%, 1.385
janelas, 60 liquidações, bônus tirado dos próprios eventos sem preço externo):

    LLTV    formula   censo    diferenca
    62,5%   12,68%   16,47%    -3,79   <- divergiu
    77,0%    7,41%    9,27%    -1,86   <- divergiu
    86,0%    4,38%    4,40%    -0,02   BATE
    91,5%    2,62%    2,73%    -0,11   BATE
    94,5%    1,68%    1,68%    -0,00   BATE
    96,5%    1,06%    1,11%    -0,05   BATE

**Quatro de seis dentro de 0,11 ponto é verificação, não coincidência.** E as
duas que divergem divergem para CIMA, e só nos LLTV baixos — que são os pares
exóticos (cbZEC, cbDOGE, cbLTC, cbXRP), os mais voláteis. É exatamente onde a
armadilha que o próprio censo DECLAROU morde: *"o oráculo é lido AGORA e as
liquidações são do passado"*.

**Então o "bônus de 9–16%" que este arquivo registra estava inflado pela
deriva.** O teto do protocolo é 15%: **16,47% não é alcançável por incentivo
nenhum.** O número certo a LLTV 62,5% é **12,68%**.

A conclusão da estratégia sobrevive — 12,68% contra os 4,56% medidos no alvo
real da Aave de 07/10 é **2,8x** — mas quem citar 16,47% vai estar citando
deriva de oráculo como se fosse incentivo. Um teste guarda os quatro casos que
batem, e outro exige que nada passe do teto de 15%.

### O que `morpho.ts` já tem, e o que NÃO está verificado

    incentivoDeLiquidacao   VERIFICADO contra 4 de 6 medianas do censo
    saudeNoMorpho           a saúde é POR MERCADO, não por carteira como a Aave
    quedaAteLiquidarNoMorpho  mesma regra da Aave (1 − 1/saúde), mesma ressalva
                              de par imune
    saudeConfere            o portão

**`ESCALA_DO_ORACULO = 1e36` NÃO está verificada contra a rede**, e está escrito
assim no código. Se ela estiver errada, a saúde sai por um fator de 10^n e o bot
miraria em posição sadia. O portão que fecha isso é `saudeConfere`: o Morpho não
expõe a saúde pronta como a Aave, então a conferência possível é o próprio
protocolo aceitar ou recusar a liquidação — e a discordância vira linha de log
em vez de tiro. É o mesmo desenho do `limiaresConferem`, que recusou 10 medições
erradas em 09/28 em vez de imprimi-las.

E `saudeConfere` grita nas DUAS direções, porque elas pedem consertos opostos:
"eu digo liquidável e ele recusou" é escala errada gastando gás; "eu digo sadia
e ele aceitou" é alvo passando por erro de conta.

### Dívida zero é `null`, e isto não é detalhe

Nem infinito, nem 1. As duas mentiriam em direções opostas — infinito esconde
alvo, 1 inventa alvo — e este projeto perdeu dias com ausência virando número.

### O que falta, na ordem, e o que está bloqueando

1. **Confirmar o endereço do Morpho PELA CORRENTE** — script escrito, roda sem
   filtro de endereço e deixa quem emite o evento se identificar. **Não vou
   escrever o endereço de cabeça:** é o defeito do `0x80d1e0f4…` que este
   arquivo registra na REGRA 0.
2. Verificar `ESCALA_DO_ORACULO` contra uma posição real.
3. Listar os mercados de LLTV ≤ 77% e ver se há posição perto de liquidar.
4. Só então o contrato: `liquidate` com callback (`onMorphoLiquidate`), que é
   outro mecanismo — o callback É o empréstimo, não há `flashLoanSimple`.

**Bloqueado agora:** o RPC público devolveu `request limit reached` em 28 de 28
janelas. O primeiro script do dia voltou "0 liquidações" com **cobertura 0%** —
e foi só porque ele declarava a cobertura que eu não publiquei "o Morpho não
liquida". Era o defeito que dá nome a este projeto, evitado pelo hábito dele.

### 2026-10-08, 19:51: o deploy confirmou o conserto do placar, e achei o MESMO furo meu

O boot trouxe a prova de que a gravação do placar está consertada:

    [CACHE] O placar dos tiros que sobreviveu ao deploy.
            vindoDoDisco: "31 tiro(s) contados antes deste boot"

Antes deste conserto, esta linha nem saía — a gravação do boot apagava o campo
e o boot seguinte começava em zero. **Os 31 atravessaram um deploy.** E com
eles: o `[PROCURA]` nas duas camadas, o `maisFragilA "[lido há 1s]"`, o
`naListaQuente "1469 (todos lidos nesta varredura completa)"` e o `[PLACAR]`
recusando concluir sobre uma janela de 2 blocos.

E o censo remediu: **221 liquidações, 59 na faixa dela, US$ 6.876,41 em 46,3
dias = US$ 4.455,91/mês, 38 migalhas/mês** (era US$ 3.996,81 e 36). O número
anda, e é por isso que ele mora no log e não num comentário meu.

**E aí eu fui procurar o piso da aposta no `[BOTÕES]` e ele NÃO ESTAVA.**

É o mesmo furo que o capítulo das 18:03 deste arquivo registra: em 28/09 eu
previ `inteiroDe US$ 49,27`, a produção deu US$ 34,63, e a causa era
`CACA_RISCO_MAXIMO=0.8` no Railway dela contra 0.6 aqui — o conserto foi o log
DIZER com que botões decidiu. Hoje eu criei o piso calculado, que é o número
que decide se o tiro especulativo sai, **e não o pus na linha que existe
exatamente para isso.** Eu não tinha como saber, do log dela, se o piso
calculado estava valendo ou se uma variável antiga o anulava.

Agora o `[BOTÕES]` diz as duas coisas, porque são perguntas diferentes — qual
piso está valendo, e DE ONDE ele veio:

    pisoDaAposta: "US$ 158.03 — CALCULADO: é o prêmio em que a aposta se paga
                   no acaso puro (custo por errada × 355 blocos entre
                   escritas). Apague CACA_APOSTA_MINIMA_USD para deixar assim;
                   defina para mandar à mão"

    ou, se a variável existir:
    "US$ 10.00 — ESCRITO em CACA_APOSTA_MINIMA_USD, e ele MANDA.
     O calculado seria US$ 158.03"

**Isto importa na prática:** se `CACA_APOSTA_MINIMA_USD=10` estiver no Railway,
o conserto de hoje não faz nada — a variável manda. E até esta linha existir,
nem eu nem ela tinham como ver isso no log.

## 2026-10-09: eu dei PUSH com a suíte VERMELHA, e o teste que piscava era um defeito real

Ela mandou o log e disse "OLHA ESSA MERDA". Antes de responder sobre o log, uma
coisa que é culpa minha e que eu tinha deixado passar: a suíte voltou
`1440 pass / 3 fail` e **eu dei push (`5b20a44`) sem ler a saída.**

### A piscada não era chateação: era o defeito escondendo-se

Os três não reprovavam — **cancelavam**:

    not ok 1091 - o orçamento é um TETO, e uma casa pendurada não segura o ciclo
    not ok 1092 - timeout maior que o orçamento não pode tornar o teto letra morta
    not ok 1093 - lista de pares vazia não chama ninguém

    # fail 0   # cancelled 3
    error: 'Promise resolution is still pending but the event loop has already resolved'

Rodado cinco vezes: passava numa, cancelava 3 em duas. E o último toque naquele
arquivo é de dias antes — não foi mudança minha de hoje.

**A causa é um defeito de produção.** `cotacoesDaBinance` montava o próprio
`AbortSignal.timeout(timeoutMs)` e **nunca via o PODÃO** do orçamento de
`cotacoesDeQualquerFonte`. Como lá o `Promise.allSettled` espera as TRÊS casas,
a perna da Binance segurava a volta inteira até o timeout DELA: um orçamento de
400ms voltava em ~2000ms. O teste pedia `gasto < 900`, a volta demorava 2s, e o
runner cancelava antes de a asserção falhar — então o defeito saía como ruído em
vez de como reprovação.

**E morde TODO ciclo em produção.** O cabeçalho daquela mesma seção registra:
*"na Railway a Binance bloqueia IP de nuvem, então TODO ciclo pagava a falha
dela antes de começar"*. A casa que nunca responde era exatamente a que o teto
não alcançava. O orçamento existia e a perna mais lenta estava fora dele.

O conserto é o `sinal` entrar por parâmetro (padrão mantém quem chama sem ele).
Cinco rodadas depois: **22/22, zero cancelado.** O teste parou de piscar porque
a piscada era o defeito.

### E o teste novo lê a ASSINATURA, pela mesma razão de ontem

O defeito era um **parâmetro ausente**, não um valor errado — a mesma forma do
`placar` fora do write do boot. Nenhum teste de valor o pega, e o teste de
comportamento que devia pegá-lo cancelava. Então o teste novo exige duas coisas:
que `cotacoesDaBinance` **aceite** o sinal, e que a chamada de dentro do
orçamento o **passe**. Aceitar e não passar seria a REGRA 3 outra vez: a regra
em dois lugares, implementada em um.

### A lição, e ela é nova neste arquivo

**Teste intermitente não é chateação: é a suíte perdendo a capacidade de
responder "quebrou?".** Eu li `1440 pass` e dei push. Com três cancelando em
duas rodadas de três, "a suíte passa" deixou de ser informação — e este projeto
inteiro é construído sobre essa frase significar algo.

A regra que sai: **`# cancelled` conta como `# fail`.** Uma promessa pendurada
num teste é um `await` que o código de produção também vai fazer.

## 2026-10-09: "voce é o dono e sua unica opçao é ganhar" — o contrato do Morpho

Ela me mandou assumir a posição de dono e decidir. Decidi duas coisas, e as
duas ao mesmo tempo, porque o tempo é meu e o dinheiro é dela:

**1. A medição que decide, rodando.** Não é "o Morpho é maior" — isso já está
medido (81% do bolo). É: **o alvo do Morpho é ALCANÇÁVEL?** Na Aave, 32 de 43
liquidações foram levadas no MESMO bloco em que ficaram liquidáveis, e é por
isso que ler-e-reagir não ganha lá. Se o Morpho for igual, o contrato novo
reconstrói o mesmo problema num lago maior. O CLAUDE.md declarava este buraco
em 28,1% de cobertura; `.tmp/aJanelaDoMorpho.ts` existe para fechá-lo, e mede
de graça a `ESCALA_DO_ORACULO` (se ela está certa, a saúde de quem FOI
liquidado sai perto de 1 no bloco anterior).

**2. `contracts/CacadorMorpho.sol`, escrito em paralelo.** Se a medição voltar
boa, deploy no mesmo dia. Se voltar ruim, perdi horas minhas e nenhum centavo
dela. Compila em **4.423 bytes** (teto do EVM: 24.576).

### O mecanismo é outro, e é a parte que a próxima sessão precisa saber

Na Aave: `flashLoanSimple` empresta, paga-se a dívida, leva-se a garantia,
vende, devolve. O empréstimo é um passo separado.

**No Morpho o callback É o empréstimo.** `liquidate` transfere a garantia para
cá, chama `onMorphoLiquidate`, e **só depois** puxa o token da dívida da nossa
conta. Dentro do callback a garantia já está na mão e nada foi pago — o
trabalho é converter garantia em dívida e autorizar o Morpho a puxar. Não
existe `flashLoan` aqui e não é preciso: a sequência do próprio `liquidate` já
dá o crédito.

### O que foi herdado do V2 sem discussão, e por quê

    cofre IMUTÁVEL          a chave mora no Railway: quem a roubar pode mandar
                            caçar, não pode escolher para onde o dinheiro vai
    amountOutMin ≠ zero     o piso vai para o ROUTER, que recusa ANTES de
                            executar, em vez de a gente reverter pagando gás
    approve zerando antes    USDT e parentes revertem sem isso
    piso conferido no fim    com os DOIS números no erro, senão o log não diz
                            se faltou pouco ou muito

E três coisas que nasceram de defeitos que este arquivo registra:

- **`poolDeVenda == address(0)` pula a venda**, e não é caso de borda: quando
  garantia e dívida são o MESMO token, vender é vender inclusive o que se
  precisa para pagar. Mediu-se isso na Aave em 8 alvos de moeda única; aqui a
  regra nasce junto.
- **Um de `seizedAssets`/`repaidShares`, nunca os dois** — e o portão está
  aqui, não só no Morpho, para a reversão dizer QUAL foi o erro. Reversão sem
  motivo legível custou a este projeto o capítulo do `naoCruzouAinda`.
- **O `data` do callback é CONFERÊNCIA, não fonte.** O que manda é o storage
  da caça; o que chega de fora no instante em que o Morpho chama é tratado como
  de fora. Três portões no callback: `msg.sender == morpho`, `caca.viva`, e o
  `data` tem de decodificar.

### E o que NÃO está verificado, declarado no próprio contrato

**O nome e a assinatura do callback** (`onMorphoLiquidate(uint256,bytes)`,
seletor `0xcf7ea196`). Se eu errei, ele **FALHA FECHADO**: o Morpho chamaria
função que não existe, não há `fallback`, e a transação inteira reverte. Erra
para o lado que custa gás, nunca para o lado que perde a garantia.

A verificação de verdade é barata e é a próxima: **o seletor `0xcf7ea196` tem
de aparecer no `eth_getCode` do Morpho Blue.** Se o Morpho chama esse callback,
o seletor está no código dele. Um `eth_getCode` responde — e o endereço do
Morpho sai da varredura, não da minha memória.

**A `ESCALA_DO_ORACULO` não entra neste contrato**, e isso é de propósito: aqui
quem decide se a posição está quebrada é o PRÓPRIO Morpho, dentro de
`liquidate`. Se a nossa conta estiver errada, o custo é gás numa reversão — não
um tiro em posição sadia que "passa".

**Nenhum endereço está escrito no contrato.** Todos vêm do construtor.
Endereço de cabeça é o defeito do `0x80d1e0f4…` que a REGRA 0 registra, só que
em hexadecimal.

## 2026-10-09, AUDITORIA: por que estávamos perdendo dinheiro, com a evidência

Ela passou um mandato: pare o vazamento antes de adicionar funcionalidade,
assuma cada diagnóstico com evidência/causa-raiz/conserto/teste, e seja preciso
sobre o que é implementado, testado, simulado e observado.

### 1. Quantos caminhos deste código conseguem gastar dinheiro

Grep por `sendTransaction` em `src/`, fora de teste: **dois arquivos**.

    src/cacarAoVivo.ts:4900     <- o caçador, atrás de CACA_ENVIAR === '1'
    src/flashArbExecutor.ts:311 <- NÃO roda em produção

`package.json` → `caca:prod` é `node dist/cacarAoVivo.js`, e nada mais. O
`flashArbExecutor` exige `FLASH_ARB_LIVE` + `FLASH_ARB_CONFIRM` próprios e não
está no script de produção. **Um único caminho de envio, OBSERVADO em
produção** (as 31 transações saíram por ele).

### 2. A contabilidade da perda, só com saldos lidos nos logs dela

    07/10 início    0.015821 ETH    0 tiros
    07/10 13:49     0.015008 ETH    7 tiros
    08/10 19:20     0.009541 ETH   31 tiros

    QUEIMADO: 0,006280 ETH = US$ 15,45 em 31 tiros (US$ 0,498 por tiro)

(Em 08/10 19:51 o saldo subiu para 0,011142 — **ela colocou ETH, não foi
ganho.** Confundir os dois seria o pior número que eu poderia publicar.)

### 3. A classificação que ela pediu, e a causa raiz é MINHA

    bug no código ............... 0 tiros   o caminho de envio funcionou: as 31
                                            saíram e foram minadas
    oportunidade que fugiu ...... 0 tiros   nenhuma chegou a ficar liquidável —
                                            o log registra o tipo "aposta"
    transação revertida ........ 31 tiros   mas reverter é o desfecho ESPERADO
                                            da aposta: é o sintoma, não a causa
    REGRA DE DECISÃO ERRADA .... 31 tiros   <<< A CAUSA RAIZ

**O piso de US$ 10 que eu escolhi liberava alvos que exigiam acertar 15,8x mais
que o acaso.** Não foi bug, não foi azar, não foi o mercado: foi a regra de
decisão, e a regra era minha. O número que fecha o argumento:

    gastei US$ 15,45  e deixei US$ 753,48 na mesa
    (4 oportunidades na brasa, média US$ 188,37, convertidas: 0)

### 4. O conserto, e por que o de ONTEM era esperança e não conserto

Ontem eu fiz o piso ser calculado (`premioQueSePagaNoAcaso`). **Mas
`CACA_APOSTA_MINIMA_USD` continuava mandando sozinha — e eu NÃO TENHO COMO VER
o Railway dela.** Se a variável estivesse em 10 (o valor que eu mesmo escrevi
em 08/10), o piso calculado seria inerte e a sangria voltaria no primeiro
movimento de mercado.

Um conserto que depende de um valor que eu não consigo conferir não é conserto.

**Agora o piso efetivo é o MAIOR entre o equilíbrio e o escrito**: a variável
pode EXIGIR MAIS e deixou de poder autorizar aposta de valor esperado negativo.
A porta de escape existe com nome que ninguém abre por acidente —
`CACA_ACEITA_APOSTA_NEGATIVA=1` — e aí é decisão dela, declarada, em vez de um
número esquecido num painel.

"Não existe perder, e sim só acertar" — as palavras dela — deixou de ser
configuração e passou a ser estrutura.

E o teste exige as duas coisas: a REGRA (variável frouxa não afrouxa o piso) e
o CÓDIGO (`Decimal.max`, não `??` — porque `??` é exatamente o que estava lá).

### 5. O que está IMPLEMENTADO, TESTADO, SIMULADO e OBSERVADO

    piso efetivo = max(equilíbrio, escrito)     implementado + testado
    piso calculado do custo medido             implementado + testado + OBSERVADO
                                                (o [BOTÕES] passou a imprimi-lo)
    placar sobrevive ao deploy                 OBSERVADO em produção 19:51
                                                ("31 tiro(s) contados antes deste boot")
    postura lê o mínimo da brasa ao vivo       OBSERVADO ("[lido há 1s]", e o número
                                                mudou sozinho entre varreduras)
    orçamento corta a perna da Binance         implementado + testado (22/22, cinco
                                                rodadas sem cancelar); NÃO observado
    CacadorMorpho.sol                          compila em 4.423 bytes. NADA testado
                                                contra a rede. NÃO deployado.

### 6. O que continua INCERTO, e eu não vou fingir que não está

- **Se o vazamento parou de verdade, eu não posso afirmar.** O que eu sei: o
  gás está em 0,011142 ETH parado desde 19:51, e o mercado está quieto
  (`maisPerto: 1,6473%` contra um desvio máximo de 0,18%). **"Não atirou porque
  o portão barrou" e "não atirou porque não havia alvo" são indistinguíveis
  neste log.** O `[BOTÕES]` do próximo boot responde.
- **A janela do Morpho** — a medição está rodando e é ela que decide se o
  contrato vale. 28,1% de cobertura não decidia nada.
- **O seletor do callback do Morpho** (`0xcf7ea196`) não foi conferido contra o
  `eth_getCode` do Morpho. Falha fechado se eu errei, mas não está provado.
- **A `ESCALA_DO_ORACULO`** continua não verificada.

## 2026-10-09: a GORJETA não compra posição, e o caminho vencedor FUNCIONA

O dia em que duas conclusões centrais deste arquivo caíram, as duas por
medição, e em que o primeiro tiro vencedor do projeto foi executado — em fork.

### As 39 transações, uma por uma (cobertura 100%)

Não existe lista de transações de uma carteira no JSON-RPC, e **reversão não
emite log**: `eth_getLogs` não as acha. O caminho honesto é o nonce, que é
monótono — achar por partição recursiva os blocos em que ele muda e ler o bloco
inteiro ali. Nonce 6 a 44, **zero nonce sem transação achada**:

    39 transações, não 31. TODAS reverteram. 8 em 07/10 + 31 em 08/10.
    custo real pelos recibos: 0,004680 ETH   (a taxa L1 é 0,1% disto)
    8 alvos distintos, 3 a 8 tiros cada, todos no V1, todos a 0,300 gwei
    saúde no bloco ANTERIOR a cada tiro: 1,00046 a 1,00208 — nenhuma cruzou

A divergência "31 contra nonce 14→45" está resolvida: 45 − 14 = 31 é o que o
placar viu; as 8 de 07/10 foram apagadas do disco pelo write do boot, e o log
daquele dia dizia 7 — eram 8.

**E o custo de US$ 15,45 que eu publiquei na auditoria está errado.** Ele saiu
de diferença de SALDO (0,006280 ETH); os recibos somam **0,004680 ETH
(US$ 11,86)**. Recibo é medição, diferença de saldo é inferência, e os 0,0016
ETH que não fecham eu não consigo explicar pela corrente — com cobertura 100%
de nonce, não há outra transação. Um dos dois números do log não é o que eu
supus que fosse.

### 1. O PREMIO NÃO ERA MIGALHA — eu extrapolei de uma linha do log

Decodificando o `input` das 39 com a interface do projeto e lendo a dívida no
bloco anterior a cada tiro:

    alvo        tiros   dívida US$    prêmio US$   falta cair
    0x9e70b090      8        95,26          1,80     0,1169%   <- a migalha
    0x616abe14      5       485,47         10,39     0,1609%
    0x33a7ec10      4     5.596,48        121,15     0,1990%
    0x12f16a0a      3     7.826,04        168,44     0,1513%
    0x07a145db      5    14.015,95        296,49     0,1464%
    0xda0d95c6      4    20.462,48        424,79     0,1900%
    0x16b00db7      5    60.913,50      1.112,56     0,2077%
    0x66bb6c29      5   151.916,73      1.932,39     0,0615%

Somando prêmio × chance cega (1/355) contra o custo pago, as 39 apostas tinham
**valor esperado +US$ 43,05** (prêmio esperado US$ 54,82 contra US$ 11,77 de
custo). Perdemos porque 0 de **0,110** acerto esperado caiu: é variância, não
regra errada. Só as 8 da migalha de US$ 1,80 eram de VE negativo.

O "US$ 10,40" que eu citei na auditoria como se fosse a população era UMA linha
do log — o alvo `0x616abe14`, um de oito. **Extrapolei de uma linha dentro da
auditoria que existia para achar erro meu.** É a regra 4 deste arquivo.

### 2. A GORJETA NÃO COMPRA POSIÇÃO NA BASE

Medido nos 33 blocos em que o bot de fato atirou:

    Spearman entre POSIÇÃO e GORJETA:  médio +0,300  (min −0,039  max +0,570)
    se o bloco fosse leilão por lance: perto de −1

    nossa posição mediana pagando 0,300 gwei: 766
    bloco 52341747: das 1.943 à nossa frente, 1.825 pagaram MENOS
    95% das transações de um bloco pagam < 0,02 gwei — e entram

Correlação POSITIVA é o oposto de leilão: o sequenciador enfileira por ordem de
**chegada** e não reordena por lance. Isso derruba a conclusão
*"é leilão, não corrida"* que este arquivo registra em duas seções, e inverte a
consequência: quem levou o alvo de US$ 49,33 na posição 6 de 537 pagando
0,046688 gwei **chegou antes**. A disputa é de LATÊNCIA.

`GORJETA_DA_FRENTE_GWEI` foi de 0,3 para **0,02** (acima do p50 do campo nos
mesmos blocos). O efeito no piso, rodado:

    0,300 gwei -> errada US$ 0,3018 -> piso US$ 107,14
    0,020 gwei -> errada US$ 0,0377 -> piso US$  13,39

    o alvo real de 07/10, US$ 47,12 -> 0,28x o acaso  >>> PASSOU A APOSTAR
    o alvo real de 08/10, US$ 11,59 -> 1,16x o acaso      continua de fora

E `GAS_MEDIDO_DE_UMA_REVERSAO` foi de 550.000 (derivado de saldo) para
**372.202** (média lida nos 39 recibos; faixa 302.984–499.316).

### 3. O PISO NO CONTRATO ESTAVA EM ZERO nas 39 transações

O sexto argumento de `cacar` era `0` nas 39. A causa: `piso = lucroCru*80/100`
com `lucroCru = 0n`, que é o que a medição por `eth_call` devolve no tiro
especulativo — a Aave reverte em posição sadia, por construção. **O portão de
resultado mínimo verificável NO CONTRATO estava desligado justamente no caminho
que manda dinheiro às cegas.** Se alguma tivesse cruzado, o contrato aceitaria
executar com lucro zero.

`pisoNoContrato` nunca devolve zero com cobertura positiva: sem medição o piso é
1,5% da dívida coberta, na unidade do ativo da dívida (bônus realizado medido
4,56%, custo de venda medido 0,59% — sobra ~3,9%, então 1,5% não barra acerto).

### 4. E A APOSTA NÃO ESPERA MAIS PELO `eth_estimateGas`

As 39 saíram com `gas: 5.000.000` — o teto de quem NÃO tem estimativa. Ela
nunca produziu número num tiro real, e não pode: a chamada reverte em posição
sadia. Esperar até 800ms por uma resposta impossível gastava 40% da janela de um
bloco, e milissegundo é a única coisa que compra posição. O saldo continua sendo
lido: ele é freio de sobrevivência, não conveniência.

### 5. O TIRO VENCEDOR FUNCIONA — provado em fork, pela primeira vez

`npm run fork` (hardhat, fork da Base no topo). O compilador não baixa neste
ambiente, então a config aponta para o solc 0.8.26 que já está no
`node_modules` — compilar com o do projeto é mais fiel que baixar outro.

Aave real, pool da Aerodrome real, **contrato publicado real** (`0x9066b0ba…`, o
mesmo das 39), devedores reais. O único fingimento é o preço: a fonte do WETH no
oráculo da Aave vira `OraculoFalso` e cai em passos.

    alvo        queda  dívida US$   estimado  REALIZADO  razão  ágio implícito
    0x66bb6c29   4,6%  132.917,53   1.843,33   5.013,89   2,72x      6,61%
    0xda0d95c6   5,9%   20.465,47     424,84   1.075,01   2,53x     10,51%
    0x07a145db  11,4%    7.009,04     151,18     613,55   4,06x      8,75%
    0x12f16a0a  12,2%    3.913,61      85,04     364,49   4,29x      9,31%

    gás de um tiro VENCEDOR: 580.473 a 679.930

Quatro de cinco completaram. O que isto fecha, pela execução e não por leitura:
o `flashLoanSimple` é devolvido; a venda no pool real cabe; o `LucroInsuficiente`
não barra acerto legítimo (pediu 1.137, deu 5.308); o lucro vai ao **cofre**.

**E `lucroEstimado` erra para BAIXO de 2,5x a 4,3x.** É o lado seguro para um
piso — prêmio subestimado nunca autoriza aposta que não se paga — e agora está
medido em vez de suposto. O ágio implícito é 6,6% a 10,5%, não os 5% assumidos,
e parte vem de a Aave deixar cobrir 100% da dívida abaixo de saúde 0,95 (dois
dos quatro cobriram a dívida inteira). Um teste guarda a DIREÇÃO: se alguma
sessão futura "otimizar" o prêmio para cima, `realizado/estimado >= 0.9`
reprova.

**O que isto NÃO prova:** 4,6% de queda é muito maior que o salto de uma escrita
de oráculo (0,10 a 0,22% medidos). Prova o MECANISMO, não que o cruzamento seja
alcançável.

### 6. O MORPHO BLUE, identificado pela corrente, e o contrato validado

O `eth_getLogs` recusou 23 de 24 janelas e a varredura por "contratos mais
chamados" não o achou em 40 blocos (806 distintos, 276 testados). Então o
endereço entrou como **hipótese** e a corrente deu o veredicto, por superfície
de interface — o contrário do defeito do `0x80d1e0f4…`, que eu publiquei sem
conferir:

    0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb   15.623 bytes
    os 10 seletores da superfície do Morpho Blue: TODOS no bytecode
    responde owner() e isLltvEnabled(62,5%) = true
    e o seletor 0xcf7ea196 de onMorphoLiquidate(uint256,bytes) ESTÁ no código
    dele: o nome do callback que o .sol declarava como NÃO VERIFICADO confere

E o teste de ponta a ponta usa o Morpho REAL. A descoberta de mercados está
bloqueada pelo RPC, mas `createMarket` é permissionless: o teste cria o próprio
mercado, pega USDC vendendo WETH no pool real, monta um devedor, derruba o
oráculo e liquida pelo nosso contrato.

    devedor: 10 WETH de garantia, 15.500 USDC de dívida
    NOSSA saúde a US$ 2.500: 1,00806452  (e o Morpho aceitou o borrow: > 1)
    NOSSA saúde a US$ 2.000: 0,80645161  (liquidável)
    cacar(2 WETH) -> SUCESSO | gasUsed 390.911 | +915,19 USDC no cofre

    modos de falha, todos recusados:
      estranho chamando cacar ....... NaoEDono
      estranho chamando o callback .. ChamadaInesperada
      os dois argumentos zero ....... UmDosDoisZero
      os dois cheios ................ UmDosDoisZero
      piso impossível ............... recusado pelo router, antes de executar

Isto fecha as quatro incertezas declaradas no `.sol`: endereço, assinatura do
callback, **ESCALA_DO_ORACULO = 1e36** (a nossa conta concorda com o
aceita/recusa do Morpho nos DOIS lados) e unidades/permissões/pagamento.

**DECLARADO:** os 915 USDC estão inflados pela divergência entre o oráculo falso
(US$ 2.000) e o preço real do pool. O valor não é alpha; o mecanismo é o que
está provado.

### O veredicto econômico de hoje, sem enfeite

**Hipótese ainda não comprovada, e agora o experimento cabe na carteira.**

    o mecanismo do tiro vencedor ....... PROVADO em fork (Aave e Morpho)
    a economia da aposta ............... VE POSITIVO já no acaso cego para
                                         prêmio acima de US$ 13,39
    a previsão do cruzamento ........... 0 de 39, e 0,110 era o esperado cego:
                                         nenhuma evidência, nem a favor nem contra
    o que falta .................... acertos. E eles custam 8x menos que ontem:
                                     0,0377 contra 0,3018 por tentativa

A carteira aguentava ~37 tentativas a 0,300 gwei; aguenta ~295 a 0,020. O
experimento que não cabia passou a caber, sem aumentar risco — baixando o preço
de errar.

### E a latência passou a ser a obra, não a gorjeta

Se a ordem no bloco é por chegada, "ser melhor que qualquer bot" tem um
significado só: **chegar primeiro no bloco da escrita do oráculo**. Já foram
tirados 800ms (a estimativa de gás que não podia responder). O que sobra no
caminho crítico, e está medido como custo e não como defeito: a medição por
`eth_call` dos dois contratos antes de enviar. Ela é o portão que distingue
"ainda não cruzou" de "meu contrato quebrou" — tirá-la seria enfraquecer
controle para produzir atividade, e isso não se faz.

### 2026-10-09, 11:47: o log dela mostrou o preço da premissa que caiu

O log trouxe, no tiro NORMAL de um prêmio de US$ 88:

    gorjeta 6.06 gwei (AMORDAÇADA — queria 20.11), adiantaria 0.005184 ETH
    osBotoes: gás 850000 | gorjeta 0.4 do lucro | risco 0.25→0.8 | aceita prejuízo SIM

**Seis gwei por lugar nenhum, e 46% do saldo congelado por tiro.** O teto medido
só valia para o tiro especulativo, com este comentário no código: *"em posição
já liquidável o teto não entra: ali o alvo é certo, e perder por lance seria
perder dinheiro na mesa"*. A premissa é a mesma que caiu hoje — lance não compra
posição na Base — então o teto passou a valer para os DOIS tiros.

**E o feedback não morreu:** `perdasSeguidas` só sobe em tiro sobre posição JÁ
liquidável, isto é, só quando uma corrida de verdade é perdida. Cada derrota
dessas DOBRA o teto, até 6 dobras (1,28 gwei — 27x o que o vencedor do alvo real
de US$ 49,33 pagou). Sem evidência de corrida perdida, o lance é o medido; com
evidência, ele sobe sozinho, e a evidência vem da corrente.

Medido com o saldo dela: uma errada a 6,06 gwei custa **160x** uma a 0,02 gwei.

E duas coisas que o log confirmou sem eu precisar pedir:
- **O RPC de produção é `base-mainnet.g.alchemy.com`.** Então o `eth_getLogs`
  que me bloqueou aqui funciona LÁ: a descoberta dos mercados do Morpho pode
  rodar como ferramenta do bot, com o log dela de saída.
- `maisFragilA "[lido há 0s]"`, `essasDuasTabelasTem "303s de idade"` e
  `oscilouAntes` apareceram: os consertos de 08/10 estão em produção.

### 2026-10-09, à noite: EU LI O SINAL DO RHO AO CONTRÁRIO. A gorjeta compra posição

Ela mandou: *"não use correlação agregada como prova causal. Avalie se a
economia por tentativa pode reduzir a probabilidade de sucesso"*. Fui medir, e
**a conclusão de hoje à tarde está errada — por um erro de sinal meu.**

A minha função de Spearman dá posto 0 à MAIOR gorjeta. Com essa convenção,
ordem decrescente perfeita — um leilão perfeito — dá rho **+1**, não −1. Eu li
o `+0,305` do bloco inteiro como *"positivo, logo o oposto de leilão"*. É o
contrário: é leilão fraco.

E a Base monta o bloco em **fatias** (Flashblocks de ~200ms). Medido nos MESMOS
33 blocos, quebrando o bloco onde a gorjeta sobe:

    rho DENTRO da fatia:  médio +0,997   p10 = p50 = p90 = 1,000   (573 fatias)
    fatias por bloco:     22,5 (min 10, max 69)
    tamanho da fatia:     p50 25 transações, p90 157

`+1,000` de p10 até p90 é ordem decrescente **perfeita** em praticamente toda
fatia. O `+0,305` do bloco inteiro é a assinatura de ~22 fatias ordenadas
concatenadas por tempo — e eu tomei essa assinatura como prova do contrário.

**Então os dois valem, e não um ou outro:** a fatia em que você cai é decidida
pela CHEGADA; o lugar dentro da fatia é decidido pelo LANCE.

### Quanto custa ser o topo da própria fatia — `F(g)`, medido em 554 fatias

    0,005 gwei -> 11%        0,30 gwei -> 66%
    0,010 gwei -> 26%        0,65 gwei -> 75%
    0,020 gwei -> 34%        1,28 gwei -> 82%
    0,050 gwei -> 47%        4,60 gwei -> 90%
    0,100 gwei -> 52%       10,00 gwei -> 94%

As nossas 39, a 0,300 gwei: fomos o topo da fatia em **15 de 39**, mediana de 1
transação acima. **Cortar para 0,020 gwei derrubava isso de 66% para 34% das
fatias: eu reduzi a chance de ganhar pela metade achando que não custava nada.**

### A gorjeta ótima CRESCE com o prêmio — e um teto fixo erra nos dois extremos

`EV = (1/355) × F(g) × prêmio − (g + baseFee) × gás × preçoDoETH`

    prêmio US$   11,59 -> 0,010 gwei | EV −US$ 0,0194   <- não aposta
    prêmio US$   47,12 -> 0,020 gwei | EV +US$ 0,0079
    prêmio US$  188,37 -> 0,050 gwei | EV +US$ 0,1842
    prêmio US$  424,79 -> 0,120 gwei | EV +US$ 0,5090
    prêmio US$ 1932,39 -> 0,650 gwei | EV +US$ 3,4589

Isto corrige os dois erros que este arquivo registra em dois dias: `0,4 × lucro`
dava **6,06 gwei** num prêmio de US$ 88 (100x acima do ótimo), e o meu teto de
**0,020** deixava US$ 1,6 de EV na mesa no prêmio de US$ 1.932.

### E O PISO ESTAVA ERRADO NOS TRÊS: ele supunha que cruzar é GANHAR

`premioQueSePagaNoAcaso` é `custo × 355`, o que supõe `F = 1`.

    US$ 158,03  gorjeta 0,300 fixa, F=1 suposto   (08/10)
    US$  13,22  gorjeta 0,020 fixa, F=1 suposto   (09/10 manhã — AUTORIZAVA EV NEGATIVO)
    US$  38,13  gorjeta ótima, F MEDIDO           (09/10 noite, este)

O piso de US$ 13,22 que eu publiquei de manhã liberava apostas de valor
esperado **negativo** — exatamente o que ela proibiu por escrito. O certo é o
prêmio em que o MELHOR EV possível cruza zero: **US$ 38,13**. Os dois alvos
reais ficam em lados opostos dele, que é a única forma de o número ser
verificável: US$ 47,12 passa (+US$ 0,0079), US$ 11,59 não (−US$ 0,0194 na
melhor gorjeta possível).

### As três afirmações de hoje, RECLASSIFICADAS

**1. "Perdemos por variância" — SOBREVIVE, com o número corrigido.** Com F
medido em vez de suposto:

    EV das 39 que eu publiquei (F=1):   +US$ 43,21
    EV das 39 com F medido (0,66):      +US$ 24,57
    acertos esperados:  0,073  (eu disse 0,110)
    chance de ZERO acertos em 39:  93,0%

Continua variância — zero em 39 era o resultado mais provável — mas **2 dos 8
alvos (13 dos 39 tiros) eram de EV negativo em qualquer gorjeta**, não um só.

**2. "A gorjeta não compra posição" — FALSA. Retirada.** Compra posição dentro
da fatia, e é isso que a curva `F(g)` mede.

**3. "Sem aumentar risco" — IMPRECISA.** O custo por tentativa agora depende do
prêmio, e com a carteira de 0,011142 ETH (US$ 27,87):

    prêmio US$    10 -> 0,005 gwei -> 1.197 tentativas
    prêmio US$   188 -> 0,050 gwei ->   427 tentativas
    prêmio US$ 1.932 -> 0,650 gwei ->    44 tentativas

Alvo grande custa mais por tentativa **porque vale pagar mais**. O certo é:
o preço de errar passou a ser proporcional ao que está em jogo.

### A lição, e ela é a mais caveira deste arquivo

Eu usei uma **correlação agregada como prova causal** e publiquei três commits
em cima dela, incluindo um que cortava a chance de ganhar pela metade. O que me
pegou não foi falta de medição — foi não ter perguntado *"qual é o sinal de rho
num leilão perfeito, com a MINHA convenção de posto?"*. Trinta segundos de
verificação contra três commits.

E o que salvou foi ela: a palavra "Flashblocks" na instrução. Eu não sabia que
a Base monta o bloco em fatias, e sem isso a medição dentro da fatia não teria
sido feita.

### 2026-10-09, noite: a PROBABILIDADE deixou de ser um número plano

Ela mandou: *"Calibre a probabilidade de sucesso. Mostre de onde ela vem... Se
os dados forem insuficientes, desenvolva a coleta necessária sem enviar
operações pagas."* O `eth_getLogs` está estrangulado, mas `eth_call` com
etiqueta de bloco RESPONDE — então a cadência do oráculo dá para medir sem
evento nenhum: ler `getAssetPrice(WETH)` em blocos CONSECUTIVOS e olhar onde o
número muda.

**5.000 blocos consecutivos, 167 minutos, cobertura 100%, 5.003 pedidos, ZERO
recusas:**

    escritas: 15 em 4.999 pares -> uma a cada 333,3 blocos (0,300% por bloco)
    salto: p10 0,0146% | p50 0,1649% | p90 0,1960% | max 0,1995%
    intervalo entre escritas: p50 301 blocos | p90 615 | max 630

Os 333,3 **confirmam os 355 do código** (6% de diferença) por um caminho
independente: `eth_call` histórico contra eventos `AnswerUpdated`. É a terceira
vez neste projeto que um número do bot é conferido por fora e passa.

**E a parte que muda a decisão: a chance DEPENDE do que falta ao alvo.**

    alvo a 0,0617% -> 87% das escritas cobrem -> 0,2601% por bloco
    alvo a 0,1169% -> 80% cobrem              -> 0,2400% por bloco
    alvo a 0,1683% -> 47% cobrem              -> 0,1400% por bloco
    alvo a 0,1838% -> 20% cobrem              -> 0,0600% por bloco
    alvo a 0,2077% ->  0% cobrem              -> 0,0000% por bloco

O alvo real de 07/10 precisava de 0,1838%: chance por bloco **0,0600%, 4,7x
menor** que a chance plana de 0,282% que o código aplicava a ele. Com o número
plano o bot tratava um alvo a 0,1838% igual a um de 0,06%.

`fracaoDasEscritasQueFecham` entra no EV, e um teste guarda a REGRA (a chance
cai com a distância, nunca sobe) em vez dos valores.

**E a amostra pequena me enganou no caminho.** A primeira varredura foi de 600
blocos, 3 escritas, e deu "uma a cada 199,7 blocos" e "0,18% em NENHUMA
escrita". Com 15 escritas: 333,3 blocos, e 20% das escritas cobrem 0,1838%. A
incerteza declarada na hora dizia que seria — e foi. **Um alvo a 0,1838% deixou
de ser impossível e passou a ser improvável, que é diferente.**

Incerteza que fica: 15 escritas, Wilson de 0,18% a 0,49% por bloco, e cada
degrau da cauda repousa em 3 a 7 escritas. Isto decide a ORDEM, não o quarto
decimal. O refinamento custa só tempo de RPC (`QUANTOS` no script).

### E eu tinha transferido um trabalho meu para ela

Eu escrevi `npm run morpho` e mandei ela *"rodar no terminal com o RPC_URL"* —
pedindo que ela montasse um ambiente de terminal para me dar um dado que o
próprio bot pode ler. Dois consertos:

1. A ferramenta lê a escada que o bot JÁ usa (`listaDeRpcs`: `CACA_RPC_URL`,
   `RPC_URL_1..9`, `CACA_RPC_URLS`), e sobe de degrau quando um provedor recusa
   toda janela. Rodado: subiu os três degraus e recusou concluir com cobertura
   zero, que é o comportamento certo.
2. **`CACA_MERCADOS_MORPHO=1` faz o próprio bot varrer uma vez, no boot, e
   imprimir no log que ela já copia.** Roda desgrudado do laço de caça: nenhuma
   varredura pode atrasar um tiro, e se falhar o bot segue caçando. Ela liga a
   variável, espera a linha `[MERCADOS]`, apaga a variável.
