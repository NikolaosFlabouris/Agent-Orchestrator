FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user (matches base image convention)
RUN groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent

COPY mock-harness.sh /usr/local/bin/mock-harness
RUN chmod +x /usr/local/bin/mock-harness

USER agent
WORKDIR /repo

ENTRYPOINT ["/usr/local/bin/mock-harness"]
