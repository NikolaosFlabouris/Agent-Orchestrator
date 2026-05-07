FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Git author identity for the dev agent's commits. The dev agent prompt tells
# the agent to `git commit -m "..."` (see scheduler.ts). Without this, the
# commit fails with "Please tell me who you are" and the agent leaves its
# work uncommitted in the workspace. Distinct from the orchestrator's
# salvage identity so commit authors reveal who actually committed.
RUN git config --system user.email "agent@agent-orchestrator.local" \
 && git config --system user.name "Coding Agent"

# Node.js is required for Claude Agent SDK regardless of project language
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install agent tools (as root, before switching user)
RUN npm install -g @anthropic-ai/claude-code
# OpenCode is distributed via npm — installs to /usr/local/bin (on the agent
# user's PATH). The previous `curl -fsSL https://get.opencode.ai | bash` line
# silently failed because that hostname does not exist; the official installer
# lives at https://opencode.ai/install but is user-scoped, so npm is preferred.
RUN npm install -g opencode-ai
# pi-coding-agent — minimal terminal coding harness with multi-provider support
# (Anthropic, OpenAI, Ollama via models.json, etc.). Invoked non-interactively
# with `pi -p "<prompt>"` for autonomous dev-env use, same pattern as OpenCode.
RUN npm install -g @mariozechner/pi-coding-agent

# Install Claude Agent SDK for TypeScript harness
RUN npm install -g @anthropic-ai/claude-agent-sdk

COPY harness/harness-sdk.ts /usr/local/bin/harness-sdk.ts
COPY harness/harness-cli.sh /usr/local/bin/harness-cli
RUN chmod +x /usr/local/bin/harness-cli

# Create non-root agent user
# UID/GID 1000 aligns with the default first user on most Linux systems,
# which simplifies file ownership on bind-mounted volumes.
# Ubuntu 24.04 ships with a default 'ubuntu' user at UID/GID 1000 — remove it first.
RUN userdel -r ubuntu 2>/dev/null; groupdel ubuntu 2>/dev/null; \
    groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent

USER agent
WORKDIR /repo
# No ENTRYPOINT — the orchestrator sets the entrypoint at container creation
# based on the resolved agent tool type (sdk → harness-sdk.ts, cli → harness-cli)
