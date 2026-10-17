# CACA V1/V2 + Morpho Multi-Hop: envio live combinado

Estado em 2026-10-16 (horario America/Sao_Paulo).
O **mesmo servico Railway** `renewed-sparkle` e o unico processo transmissor
para o CACA original (V1 e V2) e o executor Morpho Multi-Hop.
Nenhum segundo assinador ou segundo NonceManager foi criado.

## Provas de deploy

- Versao em runtime Railway: `af6ee68ec3bdd76c8185b6ede4a9cd8e633bae2e`
- Deploy Railway: `67831028-112e-48d8-adc2-4f4524e3c468` — **SUCCESS**.
- Log confirmou `[BLOCO 52703046]` com `envio AUTORIZADO`.
- Testes da versao exata: https://github.com/srtebanha-ux/crypto-gpt/actions/runs/38984278488 — SUCCESS.
- Contrato real Multi-Hop: `0x53982353F5de46736848bFAEd98D43D06BA41874`
- Tx de instalacao status=1: `0x6a4ddce2f495e4ecf4b28d5113d72106424f5b258efaafd868090c5ed3cea7d0`

## Operacao e protecoes

- `CACA_SOMENTE_MULTIHOP=0`: V1/V2 voltam a ser candidatos.
- `CACA_COMBINADO_SEGURO=1`: proibe alvos especulativos/na escrita e compara
  o lucro liquido estimado de V1/V2 e Multi-Hop no MESMO token da divida.
- `CACA_MULTIHOP_AVALIAR=1`, `CACA_MULTIHOP_ENVIAR=1` e `CACA_ENVIAR=1`.
- Rota escolhida e revalidada no mesmo caminho de assinatura e de nonce.
- Antes de qualquer broadcast, `cacaDuasRotas.ts` faz reserva sincronizada
  no volume `/app/data/caca-gas-diario.jsonl`; a ausencia de recibo/resultado
  bloqueia novos envios de AMBAS as estrategias.
- Custo maximo de gas (L1 + gasLimit * maxFee) **0,00065 ETH por tx**.
- Custo maximo de gas comprometido **0,0013 ETH por dia UTC**.
- **2 envios/dia UTC** no maximo, e no maximo **1/hora** pela regra adicional
  `CACA_MAX_ENVIOS=1`.
- Uma transacao revertida bloqueia ambas as estrategias ate o proximo dia UTC.
- Um recibo ausente ou pagamento Multi-Hop nao comprovado por evento
  bloqueia ate reconciliacao explicita, mesmo depois de virar o dia.
- Tiro de prova e tiro especulativo na escrita do oraculo desabilitados.
- `titan-arbitragem` e um monitor separado e permanece com flags de ENVIO
  desligadas, pois poderia disputar o nonce do unico assinador CACA.

## Receita ainda NAO comprovada

`envio AUTORIZADO` so significa que o bot podera enviar **se** houver
oportunidade lucrativa comprovada e todos os limites permitirem.
No ultimo log lido, `decisoes 233 (0 atirariam)`, sem nova TX de liquidacao
confirmada. Nao contar estimativas do planejador como lucro nem alegar retorno
garantido; cada sucesso exige recibo status=1, prova on-chain de pagamento
ao cofre e custos reais de gas L1/L2.

**Limitacao de dados observada:** a Alchemy reporta limite mensal excedido;
o CACA faz failover para RPC publico e preserva o cache, mas varreduras historicas
e confirmacao dos mercados Morpho tem cobertura parcial. Falta auditoria
independente do contrato. O limite de gas reduz exposicao, nao elimina risco.
