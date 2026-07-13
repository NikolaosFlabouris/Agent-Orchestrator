FROM ubuntu:24.04

# Single agent image — supersedes the previous orchestrator-agent-{base,node,python,go}
# hierarchy. All language toolchains live in one image so a repo doesn't have to
# pick one, and polyglot repos work out of the box. Cache buckets for all three
# languages are always mounted by the orchestrator (see docker.ts); empty
# buckets cost ~0 bytes until something writes to them.

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

# Node.js 22 — required for the Claude Agent SDK harness and for installing
# the npm-distributed agent CLIs below. Also serves as the Node toolchain for
# Node-based repos.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python toolchain — python3, pip, venv. Sized at ~50 MB.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Go toolchain — installed under /usr/local/go. Sized at ~150 MB.
RUN curl -fsSL https://go.dev/dl/go1.24.4.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"

# Install agent tools (as root, before switching user)
RUN npm install -g @anthropic-ai/claude-code
# OpenCode is distributed via npm — installs to /usr/local/bin (on the agent
# user's PATH).
RUN npm install -g opencode-ai
# pi-coding-agent — minimal terminal coding harness with multi-provider support
# (Anthropic, OpenAI, Ollama via models.json, etc.). Invoked non-interactively
# with `pi -p "<prompt>"` for autonomous dev-env use, same pattern as OpenCode.
RUN npm install -g @mariozechner/pi-coding-agent

# Install Claude Agent SDK for TypeScript harness
RUN npm install -g @anthropic-ai/claude-agent-sdk

COPY harness/harness-sdk.ts /usr/local/bin/harness-sdk.ts
COPY harness/harness-cli.sh /usr/local/bin/harness-cli
# Normalise line endings + set the exec bit. CRLF in the shebang line
# (a Windows-host-checkout hazard) makes the kernel look for an
# interpreter literally named `/bin/bash\r`, which then fails the exec
# with "no such file or directory" pointing at the script. Strip any
# CRs that survived the COPY so the image works regardless of the
# host's git autocrlf setting. The .gitattributes file in the repo root
# also forces LF at clone time, but we want this image to build
# correctly on already-cloned Windows working trees too.
RUN sed -i 's/\r$//' /usr/local/bin/harness-cli /usr/local/bin/harness-sdk.ts \
    && chmod +x /usr/local/bin/harness-cli

# Create non-root agent user
# UID/GID 1000 aligns with the default first user on most Linux systems,
# which simplifies file ownership on bind-mounted volumes.
# Ubuntu 24.04 ships with a default 'ubuntu' user at UID/GID 1000 — remove it first.
RUN userdel -r ubuntu 2>/dev/null; groupdel ubuntu 2>/dev/null; \
    groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent

# Pre-create the Go tree and cache root, owned by the agent user.
#
# The orchestrator bind-mounts persistent caches at /home/agent/go/pkg/mod and
# /home/agent/.cache/go-build (see docker.ts). If the parent chain doesn't
# already exist in the image, Docker auto-creates the missing parents
# (/home/agent/go, /home/agent/go/pkg, /home/agent/.cache) as root:root. The
# mounted leaf is agent-writable (host side is chowned 1000:1000), but a
# root-owned parent stops uid 1000 from creating siblings — e.g. Go's
# pkg/sumdb checksum-database dir, which fails with a Permission denied.
# Creating the parents here, agent-owned, means Docker mounts the leaves inside
# them without recreating root-owned parents.
RUN mkdir -p /home/agent/go/pkg/mod /home/agent/go/bin /home/agent/.cache/go-build \
    && chown -R agent:agent /home/agent/go /home/agent/.cache

USER agent
WORKDIR /repo
# No ENTRYPOINT — the orchestrator sets the entrypoint at container creation
# based on the resolved agent tool type (sdk → harness-sdk.ts, cli → harness-cli)
