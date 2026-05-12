import { describe, it, expect } from 'vitest';
import {
  categorizePrepFailure,
  categorizeContainerExitFailure,
} from '../../scheduler.js';

/** Unit tests for the prep-failure categorizer. The categorizer maps
 *  known recurring docker / scheduler error shapes into a stable
 *  event_type + an actionable operator message, which the scheduler's
 *  `handlePrepFailure` then records as a task_event. The UI's Task
 *  Detail page reads those event_types to render a banner above the
 *  timeline.
 *
 *  Pinning the exact strings here is intentional — the UI banner reads
 *  the message text verbatim, so any wording change here should be a
 *  conscious operator-facing change.
 */

describe('categorizePrepFailure', () => {
  describe('agent_image_missing', () => {
    it('matches the canonical dockerode 404 error string', () => {
      // This is the exact shape dockerode produces when Docker is
      // asked to create a container from a non-existent image. The
      // user-facing failure we recently diagnosed on issue #71.
      const result = categorizePrepFailure(
        '(HTTP code 404) no such container - No such image: orchestrator-agent:latest '
      );
      expect(result).not.toBeNull();
      expect(result!.eventType).toBe('agent_image_missing');
      expect(result!.message).toMatch(/orchestrator-agent:latest/);
      expect(result!.message).toMatch(/docker compose up -d --build/);
    });

    it('matches case-insensitively', () => {
      // Different Docker versions occasionally vary capitalisation.
      const result = categorizePrepFailure(
        'no such image: orchestrator-agent:latest'
      );
      expect(result?.eventType).toBe('agent_image_missing');
    });

    it('matches with surrounding whitespace and other text', () => {
      // Real-world: this string appears in the middle of an Error
      // .message that wraps with HTTP code + stack hint.
      const result = categorizePrepFailure(
        'Error: launch failed — No such image: orchestrator-agent something something'
      );
      expect(result?.eventType).toBe('agent_image_missing');
    });

    it('does not match a generic Docker 404 that mentions a different image', () => {
      // Defensive: the categorizer should only fire for the specific
      // agent image. If a future code path tries to pull a different
      // image and 404s, we don't want to mis-categorize that as
      // "agent image missing".
      const result = categorizePrepFailure(
        '(HTTP code 404) No such image: postgres:15'
      );
      expect(result).toBeNull();
    });
  });

  describe('unknown failures', () => {
    it('returns null for an unrecognised error message', () => {
      expect(categorizePrepFailure('something else broke')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(categorizePrepFailure('')).toBeNull();
    });
  });
});

describe('categorizeContainerExitFailure', () => {
  describe('harness_entrypoint_exec_failed', () => {
    it('matches the canonical kernel exec error on the CLI harness', () => {
      // This is the exact string the Docker daemon emits to container
      // stderr when the kernel can't exec the entrypoint — the
      // symptom of CRLF line endings in the harness shebang.
      const result = categorizeContainerExitFailure(
        'exec /usr/local/bin/harness-cli: no such file or directory'
      );
      expect(result).not.toBeNull();
      expect(result!.eventType).toBe('harness_entrypoint_exec_failed');
      expect(result!.message).toMatch(/CRLF/);
      expect(result!.message).toMatch(/docker compose build agent-image/);
    });

    it('matches the SDK harness variant too', () => {
      // SDK harness uses npx tsx; if the .ts file's shebang gets
      // CRLF-mangled, similar failure shape but harness-sdk in the
      // path. The regex permits both `harness-cli` and `harness-sdk`.
      const result = categorizeContainerExitFailure(
        'exec /usr/local/bin/harness-sdk: no such file or directory'
      );
      expect(result?.eventType).toBe('harness_entrypoint_exec_failed');
    });

    it('matches with surrounding container-log noise', () => {
      const result = categorizeContainerExitFailure(
        'some other line\nexec /usr/local/bin/harness-cli: no such file or directory\nmore noise'
      );
      expect(result?.eventType).toBe('harness_entrypoint_exec_failed');
    });
  });

  describe('unknown failures', () => {
    it('returns null when the logs do not match a known pattern', () => {
      expect(
        categorizeContainerExitFailure('agent crashed: syntax error in prompt')
      ).toBeNull();
    });

    it('returns null for empty logs', () => {
      expect(categorizeContainerExitFailure('')).toBeNull();
    });

    it('does not match an unrelated "no such file" error', () => {
      // Defensive: only fire when the missing file is one of the
      // harness entrypoints. A generic "no such file or directory"
      // elsewhere shouldn't trip this categorizer.
      const result = categorizeContainerExitFailure(
        'cat: /repo/missing.txt: no such file or directory'
      );
      expect(result).toBeNull();
    });
  });
});
