# Meta operacional do TITAN

Definida pela proprietaria em 22/10/2026: US$ 24 de lucro liquido por dia,
equivalentes a US$ 1 por hora em media numa janela de 24 horas.

## Criterio de resultado

- Contar somente operacoes confirmadas com recibo e entradas efetivas no cofre.
- Descontar gas L1/L2 de sucessos e falhas, taxas nao descontadas no saldo
  recebido e custos de infraestrutura/RPC atribuiveis ao periodo.
- Conversao em USD deve registrar fonte, preco e horario; token sem cotacao
  verificavel fica pendente de valoracao, nunca recebe valor presumido.
- Simulacao, lucro bruto estimado, alvo encontrado e transacao enviada sem
  recibo nao contam como lucro realizado.
- A meta e agregada: nao exige US$ 1 por operacao nem uma liquidacao por hora.
  Ganhos menores podem compor a meta desde que cada operacao pague os custos.
- Nao aumentar automaticamente risco, gas ou quantidade de tiros para
  recuperar atraso em relacao a meta. Meta comercial nao cria oportunidade.

Meta definida nao significa meta atingida. Atingimento depende de registros
confirmados que permitam calcular o resultado liquido da janela completa.
