import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ForgejoClient } from "../../forgejo.js";
import type { Repo } from "@orchestrator/shared";

const FORGEJO_URL = process.env.TEST_FORGEJO_URL ?? "";
const FORGEJO_ORCHESTRATOR_TOKEN =
  process.env.TEST_FORGEJO_ORCHESTRATOR_TOKEN ?? "";
const FORGEJO_USER = process.env.TEST_FORGEJO_USER ?? "";
const SKIP = !FORGEJO_URL || !FORGEJO_ORCHESTRATOR_TOKEN;

describe.skipIf(SKIP)("ForgejoClient integration", () => {
  let client: ForgejoClient;
  let testRepoName: string;
  // Minimal Repo object for API calls
  let repo: Repo;

  beforeAll(async () => {
    client = new ForgejoClient(FORGEJO_URL, FORGEJO_ORCHESTRATOR_TOKEN);
    testRepoName = `test-integration-${Date.now()}`;

    // Create a test repository via the API
    const res = await fetch(`${FORGEJO_URL}/api/v1/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `token ${FORGEJO_ORCHESTRATOR_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: testRepoName,
        auto_init: true,
        default_branch: "main",
      }),
    });
    expect(res.ok).toBe(true);

    repo = {
      id: 1,
      owner: FORGEJO_USER,
      name: testRepoName,
      base_branch: "main",
      agent_profile_id: null,
      review_agent_profile_id: null,
      install_steps: [],
      allow_script_steps: false,
      container_memory_mb: null,
      container_cpu_cores: null,
      merge_strategy: 'squash',
    };
  });

  afterAll(async () => {
    // Delete the test repository
    try {
      await fetch(
        `${FORGEJO_URL}/api/v1/repos/${FORGEJO_USER}/${testRepoName}`,
        {
          method: "DELETE",
          headers: { Authorization: `token ${FORGEJO_ORCHESTRATOR_TOKEN}` },
        },
      );
    } catch {
      // Best effort cleanup
    }
  });

  it("gets the current user", async () => {
    const user = await client.getCurrentUser();
    expect(user.login).toBe(FORGEJO_USER);
  });

  it("creates and retrieves an issue", async () => {
    const issue = await client.createIssue(repo, {
      title: "Test issue",
      body: "Integration test issue body",
    });
    expect(issue.number).toBeGreaterThan(0);
    expect(issue.title).toBe("Test issue");

    const fetched = await client.getIssue(repo, issue.number);
    expect(fetched.title).toBe("Test issue");
    expect(fetched.body).toBe("Integration test issue body");
  });

  it("comments on an issue", async () => {
    const issue = await client.createIssue(repo, {
      title: "Comment test",
      body: "Test body",
    });

    // Should not throw
    await client.commentOnIssue(
      repo,
      issue.number,
      "Test comment from integration test",
    );
  });

  it("closes an issue", async () => {
    const issue = await client.createIssue(repo, {
      title: "Close test",
      body: "Will be closed",
    });

    await client.closeIssue(repo, issue.number);

    const fetched = await client.getIssue(repo, issue.number);
    expect(fetched.state).toBe("closed");
  });

  it("creates and manages labels", async () => {
    // Create a label
    const label = await client.createLabel(repo, {
      name: "status/test-label",
      color: "#ff0000",
      exclusive: true,
    });
    expect(label.id).toBeGreaterThan(0);
    expect(label.name).toBe("status/test-label");

    // Apply to an issue
    const issue = await client.createIssue(repo, {
      title: "Label test",
      body: "Test",
    });
    await client.replaceLabel(repo, issue.number, [label.id]);

    // Verify
    const fetched = await client.getIssue(repo, issue.number);
    expect(fetched.labels.some((l) => l.name === "status/test-label")).toBe(
      true,
    );
  });

  it("applies scoped labels with exclusivity", async () => {
    // Create two exclusive labels with the same scope
    const label1 = await client.createLabel(repo, {
      name: "status/first",
      color: "#00ff00",
      exclusive: true,
    });
    const label2 = await client.createLabel(repo, {
      name: "status/second",
      color: "#0000ff",
      exclusive: true,
    });

    const issue = await client.createIssue(repo, {
      title: "Exclusivity test",
      body: "Test",
    });

    // Apply first label
    await client.replaceLabel(repo, issue.number, [label1.id]);
    let fetched = await client.getIssue(repo, issue.number);
    expect(fetched.labels.some((l) => l.name === "status/first")).toBe(true);

    // Apply second label — should replace the first due to exclusivity
    await client.replaceLabel(repo, issue.number, [label2.id]);
    fetched = await client.getIssue(repo, issue.number);
    expect(fetched.labels.some((l) => l.name === "status/second")).toBe(true);
  });

  it("uses replaceLabelByNames with auto-creation", async () => {
    const issue = await client.createIssue(repo, {
      title: "Label by name test",
      body: "Test",
    });

    // This should create the label if it doesn't exist and apply it
    await client.replaceLabelByNames(repo, issue.number, [
      "status/auto-created",
    ]);

    const fetched = await client.getIssue(repo, issue.number);
    expect(fetched.labels.some((l) => l.name === "status/auto-created")).toBe(
      true,
    );
  });

  it("lists issues with label filter", async () => {
    // Create a label and an issue with it
    const issue = await client.createIssue(repo, {
      title: "Filtered issue",
      body: "Test",
    });
    await client.replaceLabelByNames(repo, issue.number, ["status/queued"]);

    const issues = await client.listIssues(repo, {
      state: "open",
      labels: "status/queued",
    });
    expect(issues.some((i) => i.number === issue.number)).toBe(true);
  });

  it("gets branches", async () => {
    const branches = await client.listBranches(repo);
    expect(branches.length).toBeGreaterThan(0);
    expect(branches.some((b) => b.name === "main")).toBe(true);

    const main = await client.getBranch(repo, "main");
    expect(main.name).toBe("main");
    expect(main.commit.id).toBeTruthy();
  });

  it("manages webhooks", async () => {
    // Create a webhook
    const hook = await client.createHook(repo, {
      type: "forgejo",
      config: {
        url: "http://localhost:9999/test-webhook",
        content_type: "json",
        secret: "test-secret",
      },
      events: ["issues"],
      active: true,
    });
    expect(hook.id).toBeGreaterThan(0);

    // List webhooks
    const hooks = await client.listHooks(repo);
    expect(hooks.some((h) => h.id === hook.id)).toBe(true);

    // Delete webhook
    await client.deleteHook(repo, hook.id);
    const after = await client.listHooks(repo);
    expect(after.some((h) => h.id === hook.id)).toBe(false);
  });
});
