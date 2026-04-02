FROM orchestrator-agent-base:latest

USER root
RUN curl -fsSL https://go.dev/dl/go1.24.4.linux-amd64.tar.gz | tar -C /usr/local -xzf -
USER agent

ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"
