import { describe, it, expect } from 'vitest';
import { resolveMountSource, type MountBacking } from '../../docker.js';

// resolveMountSource translates the orchestrator's in-container paths
// (/workspaces/issue-N, /caches/N/...) into daemon-visible agent mount
// sources. Three backings exist: named volume (compose default — resolved to
// {volume, subpath}), host bind (legacy layout — prefix-swapped to the host
// path), and no mapping at all (native-Linux fallback — passed through).

const volumeMap = new Map<string, MountBacking>([
  ['/data', { kind: 'volume', name: 'agentorchestration_orchestrator-data' }],
  ['/workspaces', { kind: 'volume', name: 'agentorchestration_orchestrator-workspaces' }],
  ['/caches', { kind: 'volume', name: 'agentorchestration_orchestrator-caches' }],
]);

const bindMap = new Map<string, MountBacking>([
  ['/workspaces', { kind: 'bind', source: '/host/mnt/c/repos/AgentOrchestration/workspaces' }],
  ['/caches', { kind: 'bind', source: '/host/mnt/c/repos/AgentOrchestration/caches' }],
]);

describe('resolveMountSource', () => {
  it('resolves a workspace subdirectory to a volume subpath', () => {
    expect(resolveMountSource('/workspaces/4-issue-371', volumeMap)).toEqual({
      kind: 'volume',
      name: 'agentorchestration_orchestrator-workspaces',
      subpath: '4-issue-371',
    });
  });

  it('resolves nested paths to nested subpaths', () => {
    expect(
      resolveMountSource('/caches/4/go-build-cache', volumeMap)
    ).toEqual({
      kind: 'volume',
      name: 'agentorchestration_orchestrator-caches',
      subpath: '4/go-build-cache',
    });
  });

  it('resolves the volume root to an empty subpath', () => {
    expect(resolveMountSource('/workspaces', volumeMap)).toEqual({
      kind: 'volume',
      name: 'agentorchestration_orchestrator-workspaces',
      subpath: '',
    });
  });

  it('normalises trailing slashes before matching', () => {
    expect(resolveMountSource('/workspaces/4-issue-371/', volumeMap)).toEqual({
      kind: 'volume',
      name: 'agentorchestration_orchestrator-workspaces',
      subpath: '4-issue-371',
    });
  });

  it('prefix-swaps bind-backed paths to host paths', () => {
    expect(resolveMountSource('/workspaces/4-issue-371', bindMap)).toEqual({
      kind: 'bind',
      hostPath: '/host/mnt/c/repos/AgentOrchestration/workspaces/4-issue-371',
    });
  });

  it('does not match sibling paths that merely share a name prefix', () => {
    // /workspaces-old must not match the /workspaces mount.
    expect(resolveMountSource('/workspaces-old/x', volumeMap)).toEqual({
      kind: 'bind',
      hostPath: '/workspaces-old/x',
    });
  });

  it('picks the longest matching destination prefix', () => {
    const nested = new Map<string, MountBacking>([
      ['/workspaces', { kind: 'volume', name: 'ws' }],
      ['/workspaces/special', { kind: 'bind', source: '/host/special' }],
    ]);
    expect(resolveMountSource('/workspaces/special/repo', nested)).toEqual({
      kind: 'bind',
      hostPath: '/host/special/repo',
    });
    expect(resolveMountSource('/workspaces/other', nested)).toEqual({
      kind: 'volume',
      name: 'ws',
      subpath: 'other',
    });
  });

  it('falls back to pass-through bind when nothing matches (native Linux)', () => {
    expect(resolveMountSource('/workspaces/1-issue-2', new Map())).toEqual({
      kind: 'bind',
      hostPath: '/workspaces/1-issue-2',
    });
    expect(resolveMountSource('/workspaces/1-issue-2', null)).toEqual({
      kind: 'bind',
      hostPath: '/workspaces/1-issue-2',
    });
  });
});
