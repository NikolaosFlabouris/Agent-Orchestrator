import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_REPLAY_BYTES,
  TRUNCATION_MARKER,
  buildReplayPayload,
} from '../../ws/output.js';

const tmpFiles: string[] = [];
function writeLog(content: string): string {
  const p = path.join(
    os.tmpdir(),
    `replay-tail-cap-${tmpFiles.length}-${process.pid}.log`,
  );
  tmpFiles.push(p);
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

describe('buildReplayPayload', () => {
  it('returns the whole file when it is under the cap', () => {
    const content = 'line one\nline two\nline three\n';
    expect(buildReplayPayload(writeLog(content))).toBe(content);
  });

  it('returns the whole file at exactly the cap', () => {
    const content = 'x'.repeat(MAX_REPLAY_BYTES);
    const payload = buildReplayPayload(writeLog(content));
    expect(payload).toBe(content);
    expect(payload).not.toContain(TRUNCATION_MARKER);
  });

  it('returns null for a missing file', () => {
    expect(buildReplayPayload(path.join(os.tmpdir(), 'does-not-exist.log'))).toBeNull();
  });

  it('returns null for an empty file', () => {
    expect(buildReplayPayload(writeLog(''))).toBeNull();
  });

  it('replays only the tail of an oversized file, marker first', () => {
    // ~40 bytes per line × 20k lines ≈ 800 KB, comfortably over the cap.
    const lines = Array.from({ length: 20_000 }, (_, i) => `log line number ${i} padding padding`);
    const content = lines.join('\n') + '\n';
    expect(content.length).toBeGreaterThan(MAX_REPLAY_BYTES);

    const payload = buildReplayPayload(writeLog(content))!;
    const payloadLines = payload.split('\n');

    expect(payloadLines[0]).toBe(TRUNCATION_MARKER);
    // Marker plus at most the capped tail.
    expect(payload.length).toBeLessThanOrEqual(
      MAX_REPLAY_BYTES + TRUNCATION_MARKER.length + 1,
    );
    // The last real line is present; the first one was dropped.
    expect(payloadLines).toContain(lines[lines.length - 1]);
    expect(payloadLines).not.toContain(lines[0]);
  });

  it('cuts at a newline boundary — no partial first line', () => {
    // Every line is uniform, so any surviving line must be whole.
    const line = 'y'.repeat(99);
    const content = Array.from({ length: 5000 }, () => line).join('\n') + '\n';
    const payload = buildReplayPayload(writeLog(content))!;

    const body = payload.slice(TRUNCATION_MARKER.length + 1);
    for (const l of body.split('\n').filter(Boolean)) {
      expect(l).toBe(line);
    }
  });

  it('keeps the content when an oversized file holds no newline at all', () => {
    const content = 'z'.repeat(MAX_REPLAY_BYTES + 1000);
    const payload = buildReplayPayload(writeLog(content))!;
    expect(payload.startsWith(`${TRUNCATION_MARKER}\n`)).toBe(true);
    expect(payload.length).toBe(TRUNCATION_MARKER.length + 1 + MAX_REPLAY_BYTES);
  });
});
