import { describe, expect, it, vi } from 'vitest';
import { connectBundledForgejoToAgentNetwork } from '../../docker.js';

/**
 * Unit coverage for the Docker API status-code mapping in
 * connectBundledForgejoToAgentNetwork(). The function encodes non-obvious
 * assumptions (404 → bundled Forgejo absent, 403 → endpoint already on the
 * network) that would otherwise only surface at runtime on a real daemon.
 *
 * The function takes an injectable docker client (defaults to the singleton),
 * so we hand it a minimal stub exposing getNetwork().connect().
 */
function fakeDocker(connect: () => Promise<unknown>) {
  return {
    getNetwork: () => ({ connect }),
  } as unknown as Parameters<typeof connectBundledForgejoToAgentNetwork>[0];
}

describe('connectBundledForgejoToAgentNetwork', () => {
  it("returns 'connected' on a successful attach", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const docker = fakeDocker(connect);
    await expect(connectBundledForgejoToAgentNetwork(docker)).resolves.toBe(
      'connected',
    );
    expect(connect).toHaveBeenCalledWith({
      Container: 'forgejo',
      EndpointConfig: { Aliases: ['forgejo'] },
    });
  });

  it("maps statusCode 404 (no such container) to 'absent'", async () => {
    const docker = fakeDocker(() => Promise.reject({ statusCode: 404 }));
    await expect(connectBundledForgejoToAgentNetwork(docker)).resolves.toBe(
      'absent',
    );
  });

  it("maps statusCode 403 (endpoint already exists) to 'already-connected'", async () => {
    const docker = fakeDocker(() => Promise.reject({ statusCode: 403 }));
    await expect(connectBundledForgejoToAgentNetwork(docker)).resolves.toBe(
      'already-connected',
    );
  });

  it('rethrows unmapped Docker errors (e.g. 500) instead of swallowing them', async () => {
    const boom = { statusCode: 500, message: 'daemon exploded' };
    const docker = fakeDocker(() => Promise.reject(boom));
    await expect(connectBundledForgejoToAgentNetwork(docker)).rejects.toBe(boom);
  });

  it('rethrows non-Docker errors (no statusCode) instead of swallowing them', async () => {
    const boom = new Error('socket hang up');
    const docker = fakeDocker(() => Promise.reject(boom));
    await expect(connectBundledForgejoToAgentNetwork(docker)).rejects.toBe(boom);
  });
});
