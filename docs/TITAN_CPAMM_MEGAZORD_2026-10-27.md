# CPAMM no emissor Megazord — PR #121

O scanner ativo `cacarArbitragem` pode encaminhar candidatos CPAMM ao executor
V2 existente. Com `TITAN_CPAMM_ATOMICO=1`, a prova completa ocorre dentro da
fila Megazord; somente a quantidade otimizada segue para a revalidação do
executor oficial. Não há carteira ou transmissor adicional. Sem autorização
de envio, uma prova aprovada é apenas `simulada`.

O preflight exige `TITAN_V2_CONTRATO`, `FLASH_ARB_CODEHASH` e
`FLASH_ARB_CPAMM_FACTORIES` no formato já aceito pelo simulador. Mantém as
verificações de factories, taxas, reservas inteiras, saldo prévio de colateral,
callback completo e custo L1 + L2. Falhas depois do encaminhamento ao emissor
são desconhecidas e exigem reconciliação, nunca repetição automática.

## Economia e contabilização

A política opcional `MEGAZORD_PISO_DINAMICO=1` exige dois parâmetros explícitos:
`MEGAZORD_FALHA_MAX_BPS` (0 a 9999) e `MEGAZORD_MARGEM_RISCO_BPS` (1 a 10000).
Para custo máximo C e probabilidade assumida p, a margem líquida exigida é
`ceil(C*p/(1-p)) + ceil(C*margem)`. Não se presume uma taxa histórica de falhas.
Os pisos explicitamente configurados continuam válidos; somente o piso USD
implícito de 0,35 deixa de ser aplicado nessa modalidade. Nenhuma configuração
de produção foi alterada ou ativada por este commit.

No FlashArb V2, a estimativa L1 usa transação não assinada. O resultado realizado
usa o delta dos eventos Transfer do WETH canônico no recibo do executor,
descontando gas L2 e `l1Fee` do recibo RPC com mesmo hash de transação e bloco.
Sem dados suficientes, o líquido fica desconhecido. Reversões e resultados
negativos não são convertidos em lucro zero. O diário mantém o campo legado
de lucro bruto e acrescenta taxa L1 real e lucro líquido separadamente.

## Validação local desta entrega

- `npm run build` e `npm run typecheck`: aprovados.
- `node --require ts-node/register --test --test-concurrency=2 src/*.test.ts`:
  2.372 aprovados, zero falhas e zero ignorados.
- `npm run megazord:test-local`: um teste aprovado, incluindo fila concorrente
  e nonces sucessivos no adaptador Aave.
- `npx hardhat test --config hardhat.morpho-local.cjs forkTests/titanCpammLocal.js`:
  três testes aprovados, incluindo reversão por fee-on-transfer e saldo antigo.

São testes locais com fixtures; não são recibos de lucro em produção nem
replays de hashes históricos em fork.

## Verificações externas ainda necessárias

- Conferir identidade/codehash/owner dos contratos implantados e factories
  contra o estado atual da Base antes de habilitar o caminho em produção.
- Confirmar que todos os serviços usam um único emissor e diário persistente.
  O teste entre processos cobre um volume compartilhado; locks em volumes
  diferentes do Railway não coordenam a mesma carteira.
- Verificar disponibilidade de `l1Fee`, freshness, capacidades e failover dos
  RPCs reais. A EVM local não comprova disponibilidade da infraestrutura.
- Reproduzir transações históricas em fork com hashes/blocos identificados,
  medir cobertura de liquidações e taxa de falhas, e calibrar os limites.
- Validar receitas líquidas por janela de uma hora com recibos reais. Os testes
  locais não demonstram US$ 1–2/h nem captura de todas as liquidações.

Flashblocks, Chainlink SVR e descoberta de mercados não foram ampliados nesta
entrega. Deploys, depósitos e operações financeiras continuam dependentes de
autorização específica.
