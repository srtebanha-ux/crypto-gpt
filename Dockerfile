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
CMD ["node", "dist/live.js"]
