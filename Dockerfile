# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# dist/ = server.js (bundled, zero runtime deps) + public/ (SPA) + mock-host.mjs
RUN npm run build

# ---------- runtime stage ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --from=build /app/dist ./dist

# The bundled server has no npm dependencies at runtime, so node_modules
# is deliberately absent. Runs as the non-root "node" user (uid 1000).
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/server.js"]
