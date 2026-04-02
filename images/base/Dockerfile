FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Node.js is required for Claude Agent SDK regardless of project language
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install agent tools (as root, before switching user)
RUN npm install -g @anthropic-ai/claude-code
# OpenCode (Go binary)
RUN curl -fsSL https://get.opencode.ai | bash

# Install Claude Agent SDK for TypeScript harness
RUN npm install -g @anthropic-ai/agent-sdk

COPY harness/harness-sdk.ts /usr/local/bin/harness-sdk.ts
COPY harness/harness-cli.sh /usr/local/bin/harness-cli
RUN chmod +x /usr/local/bin/harness-cli

# Create non-root agent user
# UID/GID 1000 aligns with the default first user on most Linux systems,
# which simplifies file ownership on bind-mounted volumes.
RUN groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent

USER agent
WORKDIR /repo
# No ENTRYPOINT — the orchestrator sets the entrypoint at container creation
# based on the resolved agent tool type (sdk → harness-sdk.ts, cli → harness-cli)
