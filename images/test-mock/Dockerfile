FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user (matches base image convention)
# Handle case where GID/UID 1000 already exists (e.g., ubuntu user)
RUN if ! getent group agent >/dev/null 2>&1; then \
      groupadd -g 1000 agent 2>/dev/null || groupadd agent; \
    fi && \
    if ! id agent >/dev/null 2>&1; then \
      useradd -u 1000 -g agent -m -s /bin/bash agent 2>/dev/null || \
      useradd -g agent -m -s /bin/bash agent; \
    fi

COPY mock-harness.sh /usr/local/bin/mock-harness
RUN chmod +x /usr/local/bin/mock-harness

USER agent
WORKDIR /repo

ENTRYPOINT ["/usr/local/bin/mock-harness"]
