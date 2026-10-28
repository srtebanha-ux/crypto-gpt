# syntax=docker/dockerfile:1
# Build determinístico multi-stage: compila TypeScript e roda apenas o
# artefato compilado (dist/) + node_modules de produção na imagem final.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional corporate CA for local validation behind a TLS proxy. Never disable TLS.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY contracts ./contracts
COPY hardhat.config.cjs ./
RUN npm run build
RUN npx hardhat compile
# Prepara o contrato FlashArb de prova atomica com solc local.
# Sem isso a sonda TITAN V2 tenta ler JSON inexistente e falha fechada.
COPY scripts/gerarProvaFlashArb.cjs ./scripts/gerarProvaFlashArb.cjs
RUN node scripts/gerarProvaFlashArb.cjs
RUN test -s .tmp/artifacts/FlashArbProva.json \
  && test -s .tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Artefatos de verificacao de contrato, somente leitura ate os gates aprovarem.
COPY --from=build /app/.tmp/artifacts/FlashArbProva.json ./.tmp/artifacts/FlashArbProva.json
COPY --from=build /app/.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json ./.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json
# Executor isolado do CACA, usado somente no deploy expresso da mesma carteira.
COPY --from=build /app/.tmp/artifacts/contracts/CacadorAaveMultiHopMorpho.sol/CacadorAaveMultiHopMorpho.json ./.tmp/artifacts/contracts/CacadorAaveMultiHopMorpho.sol/CacadorAaveMultiHopMorpho.json
# A nova executora Morpho V3 precisa do bytecode no container de producao
# para o deploy unico; o build ja o compila na etapa anterior.
COPY --from=build /app/.tmp/artifacts/contracts/TitanCacadorMorphoV3.sol/TitanCacadorMorphoV3.json ./.tmp/artifacts/contracts/TitanCacadorMorphoV3.sol/TitanCacadorMorphoV3.json
COPY --from=build /app/.tmp/artifacts/contracts/TitanCacadorMorphoAero.sol/TitanCacadorMorphoAero.json ./.tmp/artifacts/contracts/TitanCacadorMorphoAero.sol/TitanCacadorMorphoAero.json

# Processo de longa duração (worker 24/7) — sem porta HTTP exposta.
#
# QUAL motor sobe é decidido por APP_ENTRY, não fixado aqui. O mesmo repo
# roda vários bots (arbitragem, direcional, scalping) e cada serviço do
# Railway é um processo diferente do MESMO código — o que os separa é só o
# ponto de entrada.
#
# Antes isto era `node dist/live.js` fixo, e railway.json repetia a mesma
# coisa em `deploy.startCommand`. O resultado: qualquer serviço novo subia
# o motor de arbitragem, e trocar o comando na interface do Railway não
# adiantava — o config-as-code do repositório mandava mais. Um serviço de
# scalping ficava horas devolvendo "Defina BINANCE_API_KEY" sem que nada
# na tela explicasse por quê.
#
# O default preserva o comportamento antigo para os serviços que já existem.
ENV APP_ENTRY=live
CMD ["sh", "-c", "node dist/${APP_ENTRY}.js"]
