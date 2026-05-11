import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock `./docker` BEFORE importing the SUT so the SUT's
// `import { getDocker } from './docker.js'` resolves to the mock.
const dockerInfoMock = vi.fn();
vi.mock('../../docker.js', () => ({
  getDocker: () => ({ info: dockerInfoMock }),
}));

// Mock `node:os` so the OS-fallback path is deterministic regardless
// of the machine running the tests.
vi.mock('node:os', () => ({
  default: {
    totalmem: () => 16 * 1024 * 1024 * 1024, // 16 GB
    cpus: () => Array(8).fill({}), // 8 cores
  },
}));

import { detectHostCapacity } from '../../host-capacity.js';

beforeEach(() => {
  dockerInfoMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectHostCapacity', () => {
  it('returns docker-sourced values when daemon responds with valid info', async () => {
    dockerInfoMock.mockResolvedValueOnce({
      MemTotal: 24 * 1024 * 1024 * 1024, // 24 GB in bytes
      NCPU: 12,
    });
    const result = await detectHostCapacity();
    expect(result.source).toBe('docker');
    expect(result.memory_total_mb).toBe(24 * 1024);
    expect(result.cpu_cores).toBe(12);
  });

  it('falls back to OS values when docker.info() throws', async () => {
    dockerInfoMock.mockRejectedValueOnce(new Error('docker unreachable'));
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
    expect(result.memory_total_mb).toBe(16 * 1024);
    expect(result.cpu_cores).toBe(8);
  });

  it('falls back to OS when docker.info() returns MemTotal: 0', async () => {
    // Some Docker Desktop preview builds return zeroed fields when
    // the engine hasn't finished initialising. Treat that as unreachable.
    dockerInfoMock.mockResolvedValueOnce({ MemTotal: 0, NCPU: 12 });
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
  });

  it('falls back to OS when docker.info() returns NCPU: 0', async () => {
    dockerInfoMock.mockResolvedValueOnce({
      MemTotal: 24 * 1024 * 1024 * 1024,
      NCPU: 0,
    });
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
  });

  it('falls back to OS when docker.info() returns missing fields', async () => {
    // Older Docker daemons or non-standard responses may omit fields
    // entirely. Treat as unreachable rather than returning NaN.
    dockerInfoMock.mockResolvedValueOnce({});
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
    expect(result.memory_total_mb).toBe(16 * 1024);
    expect(result.cpu_cores).toBe(8);
  });

  it('falls back to OS when docker.info() returns wrong-typed fields', async () => {
    dockerInfoMock.mockResolvedValueOnce({
      MemTotal: 'lots',
      NCPU: 'many',
    });
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
  });

  it('falls back to OS when getDocker() itself throws', async () => {
    // The docker module throws on getDocker() until it's been
    // initialised. The capacity probe is called during boot, so this
    // path is real (status route ping vs scheduler init order).
    dockerInfoMock.mockImplementationOnce(() => {
      throw new Error('docker not initialised');
    });
    const result = await detectHostCapacity();
    expect(result.source).toBe('os');
  });

  it('memory_total_mb is floored from the byte value (no fractional MB)', async () => {
    // 1234567890 bytes ÷ (1024*1024) = 1177.376... → floor to 1177.
    dockerInfoMock.mockResolvedValueOnce({ MemTotal: 1234567890, NCPU: 4 });
    const result = await detectHostCapacity();
    expect(result.memory_total_mb).toBe(1177);
    expect(Number.isInteger(result.memory_total_mb)).toBe(true);
  });
});
