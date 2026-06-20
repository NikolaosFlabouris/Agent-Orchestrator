import { useEffect, useState } from 'react';
import type { ProfileGauge } from '@orchestrator/shared';
import { api } from '../api.js';
import { KpiCard } from './KpiCard.js';
import {
  formatPercent,
  formatRework,
  formatDuration,
  formatTurns,
  formatTokens,
} from './reportFormat.js';

interface Props {
  repoId: number;
  modelId: string;
  harnessId: string;
  /** Human label for the selected profile, shown in the header. */
  profileLabel: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; gauge: ProfileGauge };

/** Inline, advisory performance gauge for the Create Task screen. Given a
 *  selected repo + implementation profile (resolved to its model + harness),
 *  it fetches how that combination has historically performed on that repo and
 *  shows success rate, rework, implementation duration, and turns/tokens.
 *
 *  It is deliberately non-intrusive: every state (loading / error / empty /
 *  sparse) renders quietly and NEVER blocks or alters task creation. Small
 *  samples surface an explicit "insufficient data (n=…)" notice and the rates
 *  fall back to "—" rather than a misleading 0% / 100% read off an empty set. */
export function ProfileGaugeCard({
  repoId,
  modelId,
  harnessId,
  profileLabel,
}: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    // Debounce so rapid repo/profile switching doesn't spam the endpoint; the
    // gauge is advisory, so a slightly delayed update is fine.
    const timer = setTimeout(() => {
      api
        .getProfileGauge({ repo: repoId, model: modelId, harness: harnessId })
        .then((gauge) => {
          if (!cancelled) setState({ kind: 'ready', gauge });
        })
        .catch(() => {
          if (!cancelled) setState({ kind: 'error' });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoId, modelId, harnessId]);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">
          Past performance on this repo
        </span>
        <span className="text-xs text-gray-500 truncate" title={profileLabel}>
          {profileLabel}
        </span>
      </div>

      {state.kind === 'loading' && (
        <p className="mt-2 text-sm text-gray-500">Loading history…</p>
      )}

      {state.kind === 'error' && (
        <p className="mt-2 text-sm text-gray-500">
          Performance history unavailable.
        </p>
      )}

      {state.kind === 'ready' && <GaugeBody gauge={state.gauge} />}
    </div>
  );
}

function GaugeBody({ gauge }: { gauge: ProfileGauge }) {
  const n = gauge.task_count;

  if (gauge.insufficient_data) {
    return (
      <p className="mt-2 text-sm text-amber-400/90">
        Insufficient data (n={n}) — not enough history for this model/harness on
        this repo to judge performance yet.
      </p>
    );
  }

  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KpiCard
          compact
          label="Success"
          value={gauge.success_rate}
          format={(v) => formatPercent(v)}
        />
        <KpiCard
          compact
          label="Rework"
          value={gauge.avg_rework}
          format={(v) => formatRework(v)}
          polarity="lower-good"
        />
        <KpiCard
          compact
          label="Impl time"
          value={gauge.avg_implementation_seconds}
          format={(v) => formatDuration(v)}
          polarity="lower-good"
        />
        <KpiCard
          compact
          label="Turns"
          value={gauge.avg_num_turns}
          format={(v) => formatTurns(v)}
          polarity="neutral"
        />
        <KpiCard
          compact
          label="Tokens"
          value={gauge.avg_total_tokens}
          format={(v) => formatTokens(v)}
          polarity="neutral"
        />
      </div>
      <p className="mt-1.5 text-xs text-gray-500">
        Based on {n} task{n === 1 ? '' : 's'} in the last 90 days. Advisory only.
      </p>
    </>
  );
}
