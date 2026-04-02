# Architecture Overview

## Purpose

This document describes the design of an AI Agent Orchestrator tool. The orchestrator assigns coding tasks to AI agents running autonomously in isolated container environments. Agents implement changes, which are then reviewed by a separate review agent. Once approved, the orchestrator merges the changes. The entire workflow is driven through a web UI.

## System Components

```
┌─────────────────────────────┐     ┌──────────────────────────────────────────┐
│  Machine A                  │     │  Machine B                               │
│                             │     │                                          │
│  Forgejo                    │     │  Orchestrator Container                  │
│  ┌───────────────────────┐  │     │  ┌──────────────────────────────────┐    │
│  │ Git repositories      │◄─┼─────┼─►│  Node.js process                 │    │
│  │ Issue tracking        │  │REST │  │  ├─ Fastify (API + WebSocket)    │    │
│  │ Pull requests         │  │API  │  │  ├─ Task queue + scheduler       │    │
│  │ Container registry    │  │     │  │  ├─ Docker manager (dockerode)   │    │
│  └──────────┬────────────┘  │     │  │  ├─ Forgejo API client           │    │
│             │               │     │  │  ├─ SQLite (state persistence)   │    │
│  Ports: 3000 (web), 222    │     │  │  └─ Static file server (UI)      │    │
│  (SSH)      │               │     │  └──────────────┬───────────────────┘    │
└─────────────┼───────────────┘     │                 │ Docker socket          │
              │                     │                 ▼                        │
              │  git fetch/push     │  ┌──────────┐ ┌──────────┐              │
              └─────────────────────┼─►│ Agent    │ │ Agent    │ ...          │
                (agent credential)  │  │ container│ │ container│              │
                                    │  └──────────┘ └──────────┘              │
                                    │                                          │
                                    │  Port: 8080 (orchestrator UI + API)     │
                                    └──────────────────────────────────────────┘
```

## Core Design Principles

1. **The orchestrator owns the Forgejo API.** All PR creation, merge operations, label changes, issue management, and branch deletion flow through the orchestrator. Agents interact with Forgejo only via git (fetch and push to their own branches). This separation is enforced by credential scoping — the agent token has `write:repository` scope only, with no issue or PR management permissions.

2. **Agents run in containers with controlled access.** They have git access (read all branches, write to `agent/*` branches), network access to LLM APIs and package registries, and a mounted workspace directory. Security comes from credential scoping (limited Forgejo token), branch protection (agents cannot push to protected branches), and Forgejo permissions (agents cannot merge PRs, manage labels, or close issues) — not from network isolation.

3. **All state transitions are logged as Forgejo issue comments.** This creates a human-readable audit trail directly in Forgejo.

4. **Deterministic lifecycle management.** The orchestrator never needs to guess agent state. The harness guarantees a structured result file for every possible outcome. Container exit is the authoritative completion signal.

5. **Existing tooling over custom solutions.** Git for version control, Forgejo for issue tracking and code review, Docker for isolation, SQLite for persistence. No external message queues, no external databases, no custom CI systems.

6. **Minimal operational overhead.** The entire system runs as three types of containers: Forgejo, the orchestrator, and ephemeral agent containers. One configuration file, one database file, one Docker socket.

## Machine Topology

Forgejo runs on a separate machine (Machine A) from the orchestrator and agents (Machine B). The orchestrator talks to Forgejo's REST API at a configured URL for PR, issue, and merge operations. Agent containers talk to Forgejo via git (fetch/push) using a separate, restricted credential. Both connections are standard HTTP and work across LAN, VPN, or any network where HTTP traffic can flow.

The orchestrator and agent containers share Machine B because the orchestrator manages agents via the Docker socket. Agent containers are created as sibling containers on the same Docker daemon. This is the simplest model and avoids Docker TCP/TLS configuration.

## Task Lifecycle Summary

1. User creates a task via the web UI (creates a Forgejo issue or queues an existing one)
2. Orchestrator claims the task (assigns to service account, relabels)
3. Orchestrator prepares workspace (clone/fetch, create branch, assemble prompt)
4. Orchestrator starts agent container (mounts workspace, injects task)
5. Agent fetches latest base branch, implements changes, commits, and pushes
6. Orchestrator verifies the branch was pushed (salvages local work if not), creates a PR
7. Orchestrator starts review agent container
8. Review agent evaluates changes and produces a verdict
9. If approved: orchestrator merges the PR and closes the issue
10. If rejected: orchestrator posts feedback and relaunches the dev agent (up to max attempts)
11. Slot is freed, next queued task is picked up

## Related Documents

- [01 - Forgejo Setup](./01-forgejo-setup.md)
- [02 - Task State Machine](./02-task-state-machine.md)
- [03 - Agent Containers](./03-agent-containers.md)
- [04 - Agent Harness & Tool Abstraction](./04-agent-harness.md)
- [05 - Orchestrator Core](./05-orchestrator-core.md)
- [06 - Web UI](./06-web-ui.md)
- [07 - Deployment & Operations](./07-deployment-operations.md)
- [08 - Technology Stack](./08-technology-stack.md)
- [09 - Testing Strategy](./09-testing-strategy.md)
- [10 - Implementation Plan](./10-implementation-plan.md)
