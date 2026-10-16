#!/bin/bash
# Prepara o container do Claude Code na web para rodar `npm test`, o typecheck e
# os testes de fork deste projeto.
#
# SINCRONO de proposito: o hook termina antes da sessao comecar, entao nao ha a
# corrida em que o agente roda `npm test` com `node_modules` pela metade.
set -euo pipefail

# Só na web. Numa maquina local as dependencias sao do dono do checkout.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "[hook] fora do ambiente remoto: nada a instalar"
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# `npm install` e nao `npm ci`: o estado do container e cacheado depois do hook,
# e o install reaproveita o que ja esta la em vez de apagar e baixar tudo.
echo "[hook] npm install"
npm install --no-audit --no-fund

# OS ARTEFATOS DO SOLIDITY. `src/cotarMista.ts` le o bytecode compilado do
# `CacadorV3` em `.tmp/artifacts/...` para cotar por override de estado, e os
# testes de `forkTests/` precisam dele. A pasta nao e versionada, entao sem esta
# etapa a cotacao fica sem instrumento — e este projeto tem a regra de nao
# confundir "falta de instrumento" com "falta de oportunidade".
#
# BEST-EFFORT de proposito: se o compilador nao puder ser obtido, a suite de
# unidade (`npm test`) continua passando, e a sessao comeca com um aviso em vez
# de nao comecar.
echo "[hook] hardhat compile"
if npx --no-install hardhat compile; then
  echo "[hook] artefatos do Solidity prontos"
else
  # Sem acento grave aqui: dentro de aspas duplas ele viraria substituicao de
  # comando e o aviso EXECUTARIA a suite.
  echo "[hook] AVISO: hardhat compile falhou. npm test e o typecheck seguem" >&2
  echo "[hook] funcionando; os testes de forkTests/ e a cotacao por override" >&2
  echo "[hook] precisam de: npx hardhat compile" >&2
fi

echo "[hook] pronto"
