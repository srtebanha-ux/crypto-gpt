# Morpho: coleta de devedores com fila persistente

## Evidência observada

Consulta somente leitura ao Morpho e Aave na Base, blocos 52954282–52997481:
37 eventos Aave e 2 Morpho. No cache consultado após esses eventos, 15 dos
37 devedores Aave estavam presentes e 22 ausentes. A ausência não prova que
nunca foram observados: a Aave remove endereços com dívida zerada.

Os mercados Morpho abaixo existiam no inventário, sem entrada no cache de
paginação de devedores consultado:

- 0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137
- 0xdaa04f6819210b11fe4e3b65300c725c32e55755e3598671559b9ae3bac453d7

Isso identifica uma lacuna de coleta/registro atual. Não reconstrói a lista
monitorada antes de cada transação, não prova atraso específico nem lucro perdido.
Todos esses eventos antecedem o início do deployment 40b09534, às 16:52 de Brasília.

## Mudança

A descoberta usava duas seleções por rodada UTC: mercados para validar, depois
um subconjunto desses para consultar devedores. A validação não garantia coleta.
Agora uma fila persistente ordena os mercados pela tentativa mais antiga. O
ranking de dívida desempata, sem reservar vagas permanentes a livros grandes.
A seleção cabe simultaneamente nos limites de validação e consulta. Não existe
segundo descarte de um mercado confirmado antes da enumeração de devedores.

A sequência de tentativas é salva no mesmo arquivo dos cursores e endereços,
compatível com versão 1 antiga. Uma falha roda a fila sem avançar a página que
falhou ou apagar devedores. Um mercado cujo HTTP nem começou por falta de
orçamento mantém sua prioridade. Recusas na confirmação onchain também rodam
a fila, para não bloquear os demais mercados indefinidamente.

O log MORPHO/COBERTURA-DEVEDORES informa mercado, bloco de leitura, número de
requisições, endereços recebidos, cursor, conclusão e erro da consulta. Tentativa,
coleta e oportunidade executável permanecem conceitos distintos.

## Validação e limites

Testes determinísticos verificam cobertura de 76 mercados, incluindo os dois ids
da auditoria, com reinício entre lotes; manutenção do cursor em HTTP 429; prioridade
após deadline; e o funil de produção validando e consultando seis mercados em
três rodadas, mesmo com o índice UTC fixo e ranking constante.

A fila garante progresso com inventário finito e estável e rodadas concluídas,
não cobertura instantânea de toda a Base. Os tetos HTTP/RPC e de tempo continuam
valendo. O trabalhador rápido mantém seu limite de 24 posições e as verificações
onchain, simulações integrais, piso econômico e limites financeiros não mudam.
Não há transação nem lucro realizado comprovado por esses testes.
