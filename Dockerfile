FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# The orchestrator runs as root but operates on workspaces owned by UID 1000
# (the agent user) so that the agent container can write to them. Tell git the
# orchestrator is allowed to operate on those repos. Without this, git refuses
# with "detected dubious ownership in repository".
RUN git config --system --add safe.directory '*'

# Git author identity for the orchestrator's salvage commits (see
# postDevAgent in packages/server/src/agents/develop.ts). Without this, the
# salvage `git commit` fails with "Please tell me who you are", the staged
# work is lost, and the task ends up with an empty PR.
RUN git config --system user.email "orchestrator@agent-orchestrator.local" \
 && git config --system user.name "Agent Orchestrator"

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
RUN npm ci

# Copy root tsconfig (extended by all packages)
COPY tsconfig.base.json ./

# Build shared types
COPY packages/shared ./packages/shared
RUN npm run build -w packages/shared

# Build UI
COPY packages/ui ./packages/ui
RUN npm run build -w packages/ui

# Build server
COPY packages/server ./packages/server
RUN npm run build -w packages/server

# Ship the seed script alongside the server so `npm run seed:tools` (which
# `docker exec`s into this container) can find it at /app/scripts.
COPY scripts ./scripts

ENV UI_STATIC_PATH=/app/packages/ui/dist
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "packages/server/dist/index.js"]
