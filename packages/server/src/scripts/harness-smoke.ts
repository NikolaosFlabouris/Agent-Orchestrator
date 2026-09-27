/**
 * Harness smoke test — checks every harness still works with the agent CLIs
 * in a given agent image, through the orchestrator's own launch path.
 *
 *   docker exec orchestrator \
 *     node packages/server/dist/scripts/harness-smoke.js --image <tag> [--json <path>]
 *
 * See docs/04-agent-harness.md ("Harness smoke test") and smoke/cli.ts.
 */
import {
  getAgentProfiles,
  getModel,
  getModelByProviderAndId,
  getProvider,
  openDatabaseReadOnly,
} from '../db.js';
import { initDocker, initHostPathMap } from '../docker.js';
import { listHarnesses } from '../harnesses/index.js';
import { CACHES_ROOT, WORKSPACES_ROOT } from '../constants.js';
import { runCli } from '../smoke/cli.js';
import { assertImageExists, createDockerSmokeDriver } from '../smoke/docker-driver.js';

const code = await runCli(process.argv.slice(2), {
  harnesses: listHarnesses(),
  openConfigSource(dbPath) {
    // Read-only: the runner is structurally unable to write task/attempt
    // rows (or anything else).
    openDatabaseReadOnly(dbPath);
    return {
      listProfiles: getAgentProfiles,
      getModel,
      getProvider,
      getModelByProviderAndId,
    };
  },
  async prepareDocker(image) {
    initDocker();
    await initHostPathMap();
    try {
      await assertImageExists(image);
    } catch {
      throw new Error(`image '${image}' not found on the Docker daemon`);
    }
    return createDockerSmokeDriver();
  },
  workspacesRoot: WORKSPACES_ROOT,
  cachesRoot: CACHES_ROOT,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
process.exit(code);
