import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FORGEJO_URL = process.env.TEST_FORGEJO_URL ?? "";
const FORGEJO_ORCHESTRATOR_TOKEN =
  process.env.TEST_FORGEJO_ORCHESTRATOR_TOKEN ?? "";
const FORGEJO_USER = process.env.TEST_FORGEJO_USER ?? "";
// Git clone with embedded credentials in URLs fails inside vitest on Windows
// due to an unresolved interaction between vitest worker processes and git's
// URL validation (the same commands work from a standalone Node script).
// These tests should run on Linux CI or via `node --test`.
const SKIP =
  !FORGEJO_URL || !FORGEJO_ORCHESTRATOR_TOKEN || process.platform === "win32";

describe.skipIf(SKIP)("Git operations integration", { timeout: 60_000 }, () => {
  let testRepoName: string;
  let tmpDir: string;
  let cloneDir: string;
  let repoUrl: string;

  beforeAll(async () => {
    testRepoName = `test-git-ops-${Date.now()}`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
    cloneDir = path.join(tmpDir, testRepoName);

    // Create a test repository on Forgejo
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

    // Build clone URL with embedded credentials
    const url = new URL(FORGEJO_URL);
    repoUrl = `${url.protocol}//${FORGEJO_USER}:${FORGEJO_ORCHESTRATOR_TOKEN}@${url.host}/${FORGEJO_USER}/${testRepoName}.git`;

    // Wait for repo to be fully initialized
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
    try {
      await fetch(
        `${FORGEJO_URL}/api/v1/repos/${FORGEJO_USER}/${testRepoName}`,
        {
          method: "DELETE",
          headers: { Authorization: `token ${FORGEJO_ORCHESTRATOR_TOKEN}` },
        },
      );
    } catch {
      /* */
    }
  });

  function git(args: string[], cwd?: string): string {
    return execFileSync("git", ["-c", "credential.helper=", ...args], {
      cwd: cwd ?? cloneDir,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }

  it("clones a repository", () => {
    const dest = cloneDir.replace(/\\/g, "/");
    // Spawn a child node process to run git clone
    // (vitest worker threads have an environment that causes git URL validation to fail)
    const script = `
      const {execFileSync} = require('child_process');
      execFileSync('git', ['-c','credential.helper=','clone',process.argv[1],process.argv[2]], {
        encoding:'utf-8', timeout:30000, stdio:['pipe','pipe','pipe']
      });
    `;
    execFileSync("node", ["-e", script, repoUrl, dest], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    expect(fs.existsSync(path.join(cloneDir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(cloneDir, "README.md"))).toBe(true);
  });

  it("fetches and checks out main branch", () => {
    git(["fetch", "origin", "main"]);
    const branch = git(["branch", "--show-current"]);
    expect(branch).toBe("main");
  });

  it("creates a new branch from base", () => {
    git(["checkout", "-B", "agent/issue-1-test", "origin/main"]);
    const branch = git(["branch", "--show-current"]);
    expect(branch).toBe("agent/issue-1-test");
  });

  it("commits and pushes to agent/* branch", () => {
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test Agent"]);

    fs.writeFileSync(path.join(cloneDir, "test-file.txt"), "test content\n");
    git(["add", "-A"]);
    git(["commit", "-m", "test: add test file"]);
    git(["push", "origin", "agent/issue-1-test"]);

    // Verify branch exists on remote
    const branches = git([
      "ls-remote",
      "--heads",
      "origin",
      "agent/issue-1-test",
    ]);
    expect(branches).toContain("agent/issue-1-test");
  });

  it("force-pushes on rework", () => {
    // Amend the commit and force push
    fs.writeFileSync(path.join(cloneDir, "test-file.txt"), "updated content\n");
    git(["add", "-A"]);
    git(["commit", "--amend", "-m", "test: updated test file"]);
    git(["push", "-f", "origin", "agent/issue-1-test"]);

    // Verify the push succeeded
    const log = git(["log", "--oneline", "-1"]);
    expect(log).toContain("updated test file");
  });

  it("fetches remote branch changes", () => {
    // Create a second clone to simulate another agent
    const clone2 = path.join(tmpDir, "clone2");
    execFileSync(
      "git",
      [
        "-c",
        "credential.helper=",
        "clone",
        repoUrl,
        clone2.replace(/\\/g, "/"),
      ],
      {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Fetch the branch we pushed from clone1
    execFileSync(
      "git",
      ["-c", "credential.helper=", "fetch", "origin", "agent/issue-1-test"],
      {
        cwd: clone2,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    execFileSync(
      "git",
      ["checkout", "-B", "agent/issue-1-test", "origin/agent/issue-1-test"],
      {
        cwd: clone2,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const content = fs.readFileSync(
      path.join(clone2, "test-file.txt"),
      "utf-8",
    );
    expect(content).toBe("updated content\n");

    fs.rmSync(clone2, { recursive: true, force: true });
  });
});
