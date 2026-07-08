# Test image that runs the REAL harness/harness-cli.sh (unlike test-mock,
# which replaces the harness with a simulator of its contract). Used by
# __tests__/integration/harness-usage-limit.test.ts to exercise the
# usage-limit retry loop against scripted agent commands supplied via
# meta.json agent_command.
#
# The build context is assembled by the test (Dockerfile + a copy of
# harness/harness-cli.sh side by side), because the harness script lives
# outside this directory in the repo.
#
# Tool set mirrors what the production agent image gives the harness:
# bash, jq, git, GNU coreutils (timeout/stat/date), procps (pkill),
# util-linux (flock).
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user (matches agent image convention)
# Handle case where GID/UID 1000 already exists (e.g., ubuntu user)
RUN if ! getent group agent >/dev/null 2>&1; then \
      groupadd -g 1000 agent 2>/dev/null || groupadd agent; \
    fi && \
    if ! id agent >/dev/null 2>&1; then \
      useradd -u 1000 -g agent -m -s /bin/bash agent 2>/dev/null || \
      useradd -g agent -m -s /bin/bash agent; \
    fi

COPY harness-cli.sh /usr/local/bin/harness-cli
# Belt-and-braces CRLF strip for Windows clones (same as the agent image).
RUN sed -i 's/\r$//' /usr/local/bin/harness-cli && chmod +x /usr/local/bin/harness-cli

USER agent
WORKDIR /repo

ENTRYPOINT ["/usr/local/bin/harness-cli"]
