import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { getAttemptsExport, iterateAttemptsExport } from '../db.js';
import { parseFilter } from './reports.js';
import type {
  AttemptRole,
  AttemptStatus,
  ExportAttemptsFilter,
} from '@orchestrator/shared';

/** Raw-data export API (read-only, side-effect free).
 *
 *  Where `/api/reports/*` ships pre-aggregated views for the Reports page,
 *  this ships the underlying rows: one flat, denormalised record per attempt
 *  joined with its task, repo and model, for a notebook, a spreadsheet, or an
 *  agent analysing model/harness performance. Registered under `/api/*`, so
 *  the global auth hook in auth.ts guards it exactly like the reports routes
 *  — no per-route auth here.
 *
 *  The query lives in db.getAttemptsExport (a single JOINed statement, no
 *  N+1); this module only parses params and serialises.
 */

const ROLES: AttemptRole[] = ['develop', 'review'];
const STATUSES: AttemptStatus[] = ['running', 'completed', 'failed', 'timeout'];

/** True when the caller actually supplied a parseable bound. parseFilter
 *  substitutes a default window for anything missing or unparseable; the
 *  export needs to know which bounds were real so it can leave the rest
 *  open-ended. */
function suppliedBound(v: unknown): boolean {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** `?flag=1` / `true` / `yes` (case-insensitive) — anything else is off. */
function boolParam(v: unknown): boolean {
  return typeof v === 'string' && ['1', 'true', 'yes'].includes(v.toLowerCase());
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/export/attempts — the full attempt history as flat rows.
  //
  // Params: repos, from, to (parsed by reports.parseFilter, identical
  // semantics), plus model / harness (exact match on the attempt's
  // launch-time snapshot), role (develop|review), status (running|
  // completed|failed|timeout), include_feedback=1, and format.
  //
  // DIFFERENCE FROM /api/reports/*: when BOTH `from` and `to` are omitted
  // this returns ALL history — it deliberately does NOT fall back to the
  // last DEFAULT_REPORT_WINDOW_DAYS. An export that silently truncated to
  // 30 days would quietly corrupt whatever analysis consumed it. Supplying
  // only one bound leaves the other open-ended. The window applies to the
  // attempt's own start time (falling back to its task's creation for an
  // attempt that never started), not to the task cohort the reports use.
  //
  // format=jsonl (default) streams one JSON object per line as
  // application/x-ndjson; format=json returns { rows, count, filter }.
  // Rows are ordered by attempt_id ascending in both.
  app.get('/api/export/attempts', async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    const formatRaw = typeof query.format === 'string' ? query.format : 'jsonl';
    if (formatRaw !== 'jsonl' && formatRaw !== 'json') {
      return reply
        .status(400)
        .send({ error: 'format must be one of: jsonl, json' });
    }

    const roleRaw = typeof query.role === 'string' ? query.role.trim() : '';
    if (roleRaw !== '' && !ROLES.includes(roleRaw as AttemptRole)) {
      return reply
        .status(400)
        .send({ error: `role must be one of: ${ROLES.join(', ')}` });
    }

    const statusRaw = typeof query.status === 'string' ? query.status.trim() : '';
    if (statusRaw !== '' && !STATUSES.includes(statusRaw as AttemptStatus)) {
      return reply
        .status(400)
        .send({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    // Reuse the reports parser verbatim, then drop the bounds the caller
    // never supplied (see the no-default-window note above).
    const base = parseFilter(query);
    const model = typeof query.model === 'string' ? query.model.trim() : '';
    const harness = typeof query.harness === 'string' ? query.harness.trim() : '';
    const filter: ExportAttemptsFilter = {
      repos: base.repos,
      from: suppliedBound(query.from) ? base.from : null,
      to: suppliedBound(query.to) ? base.to : null,
      model: model === '' ? null : model,
      harness: harness === '' ? null : harness,
      role: roleRaw === '' ? null : (roleRaw as AttemptRole),
      status: statusRaw === '' ? null : (statusRaw as AttemptStatus),
    };

    const includeFeedback = boolParam(query.include_feedback);

    if (formatRaw === 'json') {
      const rows = getAttemptsExport(filter, { includeFeedback });
      return { rows, count: rows.length, filter };
    }

    // JSONL: hand Fastify a Readable fed by the row generator, so the
    // history is serialised incrementally instead of being buffered into
    // one giant array + string.
    const rows = iterateAttemptsExport(filter, { includeFeedback });
    const stream = Readable.from(
      (function* lines(): Generator<string> {
        for (const row of rows) yield `${JSON.stringify(row)}\n`;
      })(),
      { objectMode: false }
    );
    return reply.header('Content-Type', 'application/x-ndjson').send(stream);
  });
}
