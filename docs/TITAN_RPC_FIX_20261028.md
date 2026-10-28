# Correção focada do boot e auditoria V3

Base desta alteração: `d63e271`, preservando o Dockerfile compatível com Railway.
Não altera permissões financeiras, contratos, limites ou configuração remota.

Validação: build/typecheck, 2.399 testes TypeScript, 10 testes dos scripts
públicos e 10 testes EVM aprovados. Smoke do código compilado atual na imagem
de runtime existente passou sem rede; o build integral da imagem não foi
repetido. Não há CI remoto ou deploy deste patch confirmado neste ambiente.

Defeitos reproduzidos e corrigidos:

- Uma falha do principal era repetida para cada secundário, acumulando até
  36 tentativas internas e atribuindo a indisponibilidade aos secundários.
  Agora o principal falha após o orçamento interno, com método/código seguros.
- O gate inicial usa Morpho como testemunha; o final usa os executores reais.
  Teste do boot completo reproduz primeiro gate aprovado e segundo recusado
  em eth_getCode. A mensagem identifica fase, índice do RPC, método, categoria
  e tentativas; nunca inclui corpo/URL do provedor.
- HTTP 5xx/transporte recebem tentativas limitadas; erros JSON-RPC permanentes
  não repetem inutilmente. Versão/id do envelope precisam corresponder à
  requisição. Erro, resultado ausente ou envelope inválido nunca aprova o gate.
- Alternativos privados podem ser configurados em MEGAZORD_RPC_ALTERNATIVOS
  (lista separada por vírgula, somente no ambiente). Host repetido não conta
  como segunda testemunha. Os controles de chainId, freshness, nonce, saldo
  e bytecode permanecem obrigatórios.
- A auditoria V3 referenciava artifactMatch/diagnosticoBytecode inexistentes,
  ocultando ReferenceError como RPC indisponível. A comparação agora executa.
  Sua compilação usa Paris/runs=200, como o artefato Hardhat; o padrão implícito
  do solc era diferente. O teste compara o artefato e rejeita opcode adulterado.

normalizarCredenciaisMegazord altera somente aliases da chave. A regressão do
boot verifica que a URL permanece intacta. Não foi identificada mutação de RPC
nessa função.

Limite da conclusão: estes defeitos de código foram reproduzidos localmente;
não há acesso aos logs atuais/Railway para afirmar a causa completa do incidente.
A Base permanece bloqueada pelo proxy (CONNECT 403), e GitHub API retorna
Forbidden. O contrato informado é 0x8F5268D7cBb4597321EB886c4Ef0CE75a6C8C317;
a equivalência do seu executável ainda precisa da leitura real, sem novo deploy.

Próxima verificação mínima no ambiente com acesso: executar
`node scripts/titanAuditarV3Railway.cjs` com os dois RPCs já configurados e
guardar o JSON público; depois coletar a mensagem do boot corrigido. Uma
aprovação do compilador local não substitui compiledExecutableMatchesOnchain
contra o bytecode real. Nenhum deploy ou envio foi realizado por esta alteração.
