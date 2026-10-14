# syntax=docker/dockerfile:1
# Build determinístico multi-stage: compila TypeScript e roda apenas o
# artefato compilado (dist/) + node_modules de produção na imagem final.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

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
