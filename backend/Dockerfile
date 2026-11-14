# Uma imagem só para API, worker e seed: mesmo código, comandos diferentes.

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# --- dev: com dependências de desenvolvimento; é o alvo usado pelos testes ---
FROM base AS dev
RUN npm ci --no-audit --no-fund
COPY . .

# --- build: compila TypeScript para JavaScript ---
FROM dev AS build
RUN npm run build

# --- prod: só o necessário para rodar ---
FROM base AS prod
ENV NODE_ENV=production
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/api.js"]
