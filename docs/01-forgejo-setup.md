# Forgejo Setup & Configuration

## Overview

Forgejo is used as both the git hosting platform and the task management system. Issues serve as task definitions, scoped labels model task state, and PRs capture agent-produced changes for review and merge. Forgejo runs self-hosted in a Docker container.

## Why Forgejo

- Lightweight Go binary with minimal resource requirements (512MB RAM sufficient)
- Comprehensive REST API covering repos, issues, labels, PRs, and merge operations
- Built-in container registry for dev images
- Built-in issue tracker eliminates need for a separate task management tool
- Scoped exclusive labels provide task state machine semantics
- Self-hosted, reducing external service dependencies
- Drop-in alternative to Gitea with active community governance

## Deployment

Forgejo runs as a Docker container on Machine A. See [07 - Deployment & Operations](./07-deployment-operations.md) for the docker-compose configuration and backup strategy.

## API Configuration

### User Accounts

Two Forgejo user accounts are required:

| Account | Role | Purpose |
|---------|------|---------|
| `orchestrator` | Repository owner or admin | Owns repositories. Creates PRs, merges, manages labels/issues via API. |
| `agent` | Repository collaborator (write) | Used by agent containers for git fetch/push to `agent/*` branches only. |

The `agent` account is added as a collaborator with write access on each repository. Branch protection (see below) prevents this account from pushing to protected branches. The account has no admin or owner privileges.

### Authentication Tokens

Two separate API tokens are required, one per user account:

| Token | Account | Scopes | Used By | Purpose |
|-------|---------|--------|---------|---------|
| Orchestrator token | `orchestrator` | `write:repository`, `write:issue` | Orchestrator process | Create PRs, update labels, merge, comment, manage issues via Forgejo API |
| Agent token | `agent` | `write:repository` | Agent containers | Git fetch (all branches) and push (`agent/*` branches only). No `write:issue` scope — agents cannot manage PRs, labels, or issues via the API. |

The orchestrator token is held in memory by the orchestrator process and used exclusively for Forgejo REST API calls. It is never written to any workspace or container filesystem.

The agent token is embedded in the git remote URL within agent workspaces (e.g., `http://agent:<token>@forgejo:3000/org/repo.git`). Agents use it for git operations only. Even though the token has `write:repository` scope, branch protection prevents pushing to protected branches, and the absence of `write:issue` scope prevents PR/label/issue management via the API.

### Branch Protection

Branch protection is a critical security boundary. It is configured **only on the base branch** (`main` or the configured base branch) — not on the entire repository. Agent branches (`agent/*`) are intentionally unprotected so that agents can push to them.

**Protected branch: `main` (or the configured base branch)**

| Setting | Value | Purpose |
|---------|-------|---------|
| Enable branch protection | Yes | Prevent direct push to base branch |
| Disable push | Yes | Nobody pushes to `main` directly — changes go through PRs |
| Enable merge whitelist | Yes | Only the `orchestrator` account can merge PRs |
| Merge whitelist users | `orchestrator` | Agents cannot merge even if they craft an API call |

**Unprotected: `agent/*` branches**

No branch protection rules are applied to the `agent/` namespace. Agents must be able to `git push` to their task branches (e.g., `agent/issue-42-add-login-validation`). The orchestrator's deterministic branch naming ensures all agent work lands under this prefix.

This ensures that agents can push to their working branches but cannot push to `main`. The only path to `main` is through a PR merged by the orchestrator.

### API Endpoints Used

The orchestrator interacts with the following Forgejo API areas:

- **Issues**: list, create, update, comment, close
- **Labels**: list, create, replace on issues
- **Pull Requests**: create, update, merge, add review comments
- **Repositories**: list, get info
- **Users**: get current user (connection health check)

### API Rate Limiting

Self-hosted Forgejo has no API rate limiting enabled by default. Rate limiting is opt-in via `app.ini`. The orchestrator generates approximately:

- 12-16 API calls per task lifecycle (label changes, PR creation, comments, merge)
- Webhook-driven events replace most polling; a 60-second fallback poll adds ~1 request/minute
- Agent containers generate additional git fetch/push traffic (HTTP, not REST API)

This is negligible load for the Forgejo process.

### Swagger/OpenAPI

The auto-generated API reference is available at `https://<instance>/api/swagger` and the OpenAPI spec at `https://<instance>/swagger.v1.json`.

## Issue Tracking Configuration

### Label Setup

The following scoped labels must be created (see [02 - Task State Machine](./02-task-state-machine.md) for full details):

**Status labels** (exclusive scope: `status/`):
- `status/queued`
- `status/preparing`
- `status/in-progress`
- `status/in-review`
- `status/changes-needed`
- `status/merged`
- `status/failed`
- `status/cancelled`
- `status/awaiting-human-merge`
- `status/awaiting-human-review`
- `status/needs-human-review`

**Override labels:**
- `human-merge` — PR left open for manual merge after agent work completes
- `human-review` — skip automated review, wait for human review

**Repository labels** (for multi-repo task routing):
- `repo/<name>` — one per configured repository

### Exclusive Label Behavior

Forgejo's scoped labels enforce that only one label with the same scope can be active on an issue at a time. Labels with `/` in the name and the "Exclusive" option set share a scope based on the prefix before the last `/`. This means assigning `status/in-progress` automatically removes any other `status/*` label.

### Issue Templates

A standardized issue template for orchestrator tasks:

```yaml
# .forgejo/issue_template/agent-task.yaml
name: Agent Task
about: Task for automated agent implementation
title: ''
labels:
  - status/queued
body:
  - type: textarea
    id: description
    attributes:
      label: Task Description
      description: Describe what needs to be implemented
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance Criteria
      description: How will we know this is done correctly?
  - type: textarea
    id: dependencies
    attributes:
      label: Dependencies
      description: List issue dependencies as checklist items
      placeholder: |
        - [ ] #issue_number
  - type: dropdown
    id: repo
    attributes:
      label: Target Repository
      options:
        - repo/frontend
        - repo/backend
```

### Dependency Tracking

Task dependencies are tracked via checklist items in the issue body:

```markdown
## Dependencies
- [ ] #38
- [ ] #39
```

The orchestrator parses checklist items **inside a `## Dependencies` (or
`### Dependencies`) section only** — checkbox lists elsewhere in the body
(acceptance criteria etc.) never gate scheduling. A dependency is satisfied
when its issue is **closed**; until then the task stays queued and shows as
*blocked* in the orchestrator UI (blocked is display-only — never a status
label on Forgejo or a stored task state).

Details:

- The issue body is the source of truth. Edits made directly on Forgejo
  (adding, removing, or ticking items) sync to the orchestrator instantly
  via webhook and within one poll cycle (60s) without webhooks.
- A **checked** box (`- [x] #38`) is a manual override — the dependency
  counts as satisfied regardless of the issue's state. Use it when the work
  happened outside the listed issue, or to neutralise a bad reference.
- Issue numbers resolve within the task's own repo. Cross-repo references
  (`owner/repo#38`) and URLs are ignored.
- A reference to an issue that doesn't exist, or a circular dependency,
  keeps the task blocked; the Task Detail page lists each dependency with
  its state and how to repair it.
- Programmatic intake (the UI's create-task form and the MCP `create_task`
  tool's `dependencies` parameter) writes this section through one
  canonical formatter, so the syntax never drifts.

See `13-task-dependencies.md` for the full design.

## OAuth2 Provider Configuration

Forgejo acts as the OAuth2 provider for orchestrator UI authentication. An OAuth2 application must be registered in Forgejo's admin settings:

1. Navigate to Site Administration → Applications
2. Create a new OAuth2 application
3. Set the redirect URI to `http://<orchestrator-host>:8080/auth/callback`
4. Record the Client ID and Client Secret for orchestrator configuration

## References

- Official Docker installation: https://forgejo.org/docs/next/admin/installation/docker/
- Download page: https://forgejo.org/download/
- API usage guide: https://forgejo.org/docs/latest/user/api-usage/
- Labels documentation: https://forgejo.org/docs/latest/user/labels/
- Issue templates: https://forgejo.org/docs/next/user/issue-pull-request-templates/
