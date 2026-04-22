import fsp from "node:fs/promises";

// ---------------------------------------------------------------------------
// Disk-usage cache (stale-while-revalidate)
// ---------------------------------------------------------------------------
//
// Computing WORKSPACES_ROOT + CACHES_ROOT directory sizes used to happen
// synchronously on the event-loop thread — every `/api/status` request and
// every poll tick (for the disk-threshold alert) would walk the entire tree
// with `fs.statSync`. With many workspaces that scan takes tens of seconds
// and blocks every other request behind it: dashboard auto-refresh stacks up,
// `/health` times out, WebSocket upgrades stall, the Settings page shows
// empty fields for tens of seconds. The orchestrator "runs" but the UI feels
// frozen.
//
// Fix: compute sizes with async fs.promises (no event-loop block), cache for
// 60 s, and serve from cache even while a background refresh is in flight.
// First call after boot returns null until the first refresh completes;
// every subsequent call is instant.

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? "/workspaces";
const CACHES_ROOT = process.env.CACHES_ROOT ?? "/caches";

const DISK_CACHE_TTL_MS = 60_000;

export interface DiskUsage {
  workspaces: number;
  caches: number;
  at: number;
}

let diskCache: DiskUsage | null = null;
let diskRefreshing: Promise<void> | null = null;

async function getDirSizeAsync(dirPath: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        try {
          total += (await fsp.stat(fullPath)).size;
        } catch {
          /* skip — file may have vanished mid-scan */
        }
      } else if (entry.isDirectory()) {
        total += await getDirSizeAsync(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Kick off a background refresh if the cache is stale and none is in flight.
 * Non-blocking — the current cache (possibly stale, possibly null) is what
 * `getDiskCache()` returns until the refresh finishes.
 */
export function ensureDiskCache(): void {
  if (diskCache && Date.now() - diskCache.at < DISK_CACHE_TTL_MS) return;
  if (diskRefreshing) return;
  diskRefreshing = (async () => {
    const [workspaces, caches] = await Promise.all([
      getDirSizeAsync(WORKSPACES_ROOT),
      getDirSizeAsync(CACHES_ROOT),
    ]);
    diskCache = { workspaces, caches, at: Date.now() };
  })().finally(() => {
    diskRefreshing = null;
  });
}

/** Current cached disk usage, or `null` if the first refresh hasn't finished. */
export function getDiskCache(): DiskUsage | null {
  return diskCache;
}

// Kick off the first refresh at module-load time so the cold-start window is
// short. `void` discards the promise; errors are swallowed inside.
void ensureDiskCache();
