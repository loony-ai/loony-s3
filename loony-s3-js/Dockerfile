# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
# node:sqlite is still experimental in Node 24
ENV NODE_OPTIONS=--experimental-sqlite

EXPOSE 3000

# dumb-init reaps zombie processes and forwards signals correctly
RUN apk add --no-cache dumb-init

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
