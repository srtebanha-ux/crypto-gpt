# syntax=docker/dockerfile:1
# Build determinístico multi-stage: compila TypeScript e roda apenas o
# artefato compilado (dist/) + node_modules de produção na imagem final.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY contracts ./contracts
COPY hardhat.config.cjs ./
RUN npm run build
# Gera o bytecode necessário ao cotador V3 (state override em eth_call).
# Hardhat utiliza o solc local definido em hardhat.config.cjs: sem baixar compilador.
RUN npx hardhat compile

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# O cotador misto lê este JSON em tempo de execução; nenhum contrato é implantado.
COPY --from=build /app/.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json ./.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json

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
