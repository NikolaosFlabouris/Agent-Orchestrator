import { describe, it, expect } from 'vitest';
import { categorizePrepFailure } from '../../scheduler.js';

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
