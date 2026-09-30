# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Asia/Kolkata \
    PORT=8080 \
    DATA_DIR=/app/data

RUN apk add --no-cache tzdata wget

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY shared ./shared
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/index.js"]
