FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY agent ./agent
COPY scripts ./scripts
RUN npm run build:local

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*
ENV ORDERGRID_CHROME_PATH=/usr/bin/chromium
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/agent ./agent
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /app/.ordergrid && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node","dist/server.js"]

