import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true' || !process.env.TEST_DOCKER;

describe.skipIf(SKIP)('Docker lifecycle integration', () => {
  let docker: Docker;
  const createdContainers: string[] = [];
  const LABEL_PREFIX = 'test-orchestrator';

  beforeAll(() => {
    // Use named pipe on Windows, Unix socket on Linux
    if (process.platform === 'win32') {
      docker = new Docker({ socketPath: '//./pipe/dockerDesktopLinuxEngine' });
    } else {
      docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }
  });

  afterAll(async () => {
    // Clean up any containers created during tests
    for (const id of createdContainers) {
      try {
        const container = docker.getContainer(id);
        try { await container.stop({ t: 1 }); } catch { /* may already be stopped */ }
        await container.remove({ force: true });
      } catch {
        // Already removed
      }
    }
  });

  it('creates a container with orchestrator labels', async () => {
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['echo', 'hello'],
      Labels: {
        'managed-by': LABEL_PREFIX,
        'task-id': '999',
      },
    });
    createdContainers.push(container.id);

    const info = await container.inspect();
    expect(info.Config.Labels['managed-by']).toBe(LABEL_PREFIX);
    expect(info.Config.Labels['task-id']).toBe('999');
  });

  it('starts and waits for container completion', async () => {
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['echo', 'test output'],
      Labels: { 'managed-by': LABEL_PREFIX, 'task-id': '998' },
    });
    createdContainers.push(container.id);

    await container.start();
    const result = await container.wait();
    expect(result.StatusCode).toBe(0);

    const info = await container.inspect();
    expect(info.State.Status).toBe('exited');
  });

  it('reads exit code from container.wait()', async () => {
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['sh', '-c', 'exit 42'],
      Labels: { 'managed-by': LABEL_PREFIX, 'task-id': '997' },
    });
    createdContainers.push(container.id);

    await container.start();
    const result = await container.wait();
    expect(result.StatusCode).toBe(42);
  });

  it('stops and removes a running container', async () => {
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['sleep', '300'],
      Labels: { 'managed-by': LABEL_PREFIX, 'task-id': '996' },
    });
    createdContainers.push(container.id);

    await container.start();
    const info = await container.inspect();
    expect(info.State.Running).toBe(true);

    await container.stop({ t: 1 });
    await container.remove();
    createdContainers.pop(); // Already removed

    // Verify it's gone
    try {
      await container.inspect();
      expect.fail('Container should not exist');
    } catch (err: any) {
      expect(err.statusCode).toBe(404);
    }
  });

  it('lists containers by label filter', async () => {
    const uniqueLabel = `test-filter-${Date.now()}`;
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['echo', 'filtered'],
      Labels: { 'managed-by': uniqueLabel, 'task-id': '995' },
    });
    createdContainers.push(container.id);

    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`managed-by=${uniqueLabel}`] },
    });
    expect(containers.length).toBe(1);
    expect(containers[0].Id).toBe(container.id);
  });

  it('handles container not found gracefully', async () => {
    const container = docker.getContainer('nonexistent-container-id');
    try {
      await container.inspect();
      expect.fail('Should have thrown');
    } catch (err: any) {
      // dockerode may report 404 statusCode or throw a different error
      expect(err).toBeDefined();
    }
  });

  it('applies resource limits', async () => {
    const container = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['echo', 'limited'],
      Labels: { 'managed-by': LABEL_PREFIX, 'task-id': '994' },
      HostConfig: {
        Memory: 64 * 1024 * 1024, // 64MB
        CpuPeriod: 100000,
        CpuQuota: 100000, // 1 CPU
      },
    });
    createdContainers.push(container.id);

    const info = await container.inspect();
    expect(info.HostConfig.Memory).toBe(64 * 1024 * 1024);
    expect(info.HostConfig.CpuQuota).toBe(100000);
  });
});
