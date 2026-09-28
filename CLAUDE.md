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

## Como este projeto mede o próprio erro

O defeito que mais aparece aqui tem nome: **ausência com cara de resposta** —
um número que o algoritmo inventou (o chão de uma varredura, um default
esquecido, um piso desatualizado) publicado como se fosse medição.

Todo conserto vira teste com o caso real que o expôs, e o comentário diz o
número medido e a data. Não é zelo: é o único jeito de a próxima sessão não
repetir. Em 2026-09-27 os testes foram de 949 para 1.214 por causa disso.
