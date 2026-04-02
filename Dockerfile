FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
RUN npm ci

# Build shared types
COPY packages/shared ./packages/shared
RUN npm run build -w packages/shared

# Build UI
COPY packages/ui ./packages/ui
RUN npm run build -w packages/ui

# Build server
COPY packages/server ./packages/server
RUN npm run build -w packages/server

ENV UI_STATIC_PATH=/app/packages/ui/dist
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "packages/server/dist/index.js"]
