import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type JobDetail as JobDetailData } from '../lib/api';
import {
  Ago,
  Button,
  Card,
  Empty,
  ErrorBox,
  Spinner,
  StatusBadge,
  cx,
  ms,
  shortId,
} from '../components/ui';

const TERMINAL = ['COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];

export function JobDetail() {
  const { jobId = '' } = useParams();
  const qc = useQueryClient();
  const [action, setAction] = useState<unknown>(null);

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetailData>(`/jobs/${jobId}`),
    // Polls at 2s while the job is in flight, then STOPS once it is terminal.
    // Polling a finished job forever is the easy mistake — it costs the API a
    // request per open tab, indefinitely, to learn nothing.
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 2_000),
  });

  const logs = useQuery({
    queryKey: ['job-logs', jobId],
    queryFn: () => api.get<{ data: LogLine[] }>(`/jobs/${jobId}/logs`),
    refetchInterval: (q) => (job.data && TERMINAL.includes(job.data.status) ? false : 3_000),
    enabled: !!job.data,
  });

  const retry = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/jobs/${jobId}/retry`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['job', jobId] }),
    onError: setAction,
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/jobs/${jobId}/cancel`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['job', jobId] }),
    onError: setAction,
  });

  if (job.isLoading) return <Spinner />;
  if (job.isError) return <ErrorBox error={job.error} />;
  const d = job.data;
  if (!d) return null;

  const isTerminal = TERMINAL.includes(d.status);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <StatusBadge status={d.status} />
              <span className="mono text-sm text-mist-300">{shortId(d.id)}</span>
              {!isTerminal && (
                <span className="flex items-center gap-1.5 text-xs text-mist-500">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-signal-500" />
                  live
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-mist-500">
              <span>
                queue <span className="text-mist-300">{d.queue_name ?? '—'}</span>
              </span>
              <span>
                handler <span className="text-mist-300">{d.handler}</span>
              </span>
              <span>
                priority <span className="tnum text-mist-300">{d.priority}</span>
              </span>
              <span>
                timeout <span className="tnum text-mist-300">{ms(d.timeout_ms)}</span>
              </span>
              <span>
                attempts{' '}
                <span className="tnum text-mist-300">
                  {d.attempt_count}/{d.max_attempts}
                </span>
              </span>
            </div>
            {/* The retry contract in prose. This is where an invisible system
                property becomes visible to whoever is debugging. */}
            <div className="mt-1.5 text-xs text-mist-500">
              {d.retry_policy.strategy.toLowerCase()} backoff from {ms(d.retry_policy.base_delay_ms)}{' '}
              up to {ms(d.retry_policy.max_delay_ms)} · ±{d.retry_policy.jitter_pct}% jitter
            </div>
          </div>

          <div className="flex gap-2">
            {!isTerminal && (
              <Button size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                Cancel
              </Button>
            )}
            {isTerminal && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                title="Creates a NEW job linked to this one; this job's history is preserved"
              >
                Retry as new job
              </Button>
            )}
          </div>
        </div>

        {action != null && (
          <div className="mt-3">
            <ErrorBox error={action} />
          </div>
        )}

        {retry.data && (
          <div className="mt-3 rounded border border-signal-600/30 bg-signal-500/10 px-3 py-2 text-xs">
            Replay created:{' '}
            <Link to={`/jobs/${retry.data.id}`} className="mono text-signal-400">
              {shortId(retry.data.id)}
            </Link>
          </div>
        )}

        {d.parent_job_id && (
          <div className="mt-3 text-xs text-mist-500">
            Replay of{' '}
            <Link to={`/jobs/${d.parent_job_id}`} className="mono text-signal-500">
              {shortId(d.parent_job_id)}
            </Link>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b border-ink-800 px-4 py-3">
            <h2 className="text-sm font-semibold">Attempts</h2>
          </div>
          <div className="p-4">
            {d.executions.length === 0 ? (
              <Empty
                title="Not started yet"
                hint="An attempt row appears the moment a worker begins executing."
              />
            ) : (
              <ol className="flex flex-col gap-3">
                {[...d.executions].reverse().map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        className={cx(
                          'mt-1 h-2 w-2 shrink-0 rounded-full',
                          e.status === 'SUCCEEDED'
                            ? 'bg-ok-500'
                            : e.status === 'RUNNING'
                              ? 'live-dot bg-signal-500'
                              : e.status === 'ABANDONED'
                                ? 'bg-warn-500'
                                : 'bg-bad-500',
                        )}
                      />
                      <span className="mt-1 w-px flex-1 bg-ink-700" />
                    </div>
                    <div className="min-w-0 flex-1 pb-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium">Attempt {e.attempt}</span>
                        <span
                          className={cx(
                            'text-xs',
                            e.status === 'SUCCEEDED'
                              ? 'text-ok-500'
                              : e.status === 'ABANDONED'
                                ? 'text-warn-500'
                                : e.status === 'RUNNING'
                                  ? 'text-signal-500'
                                  : 'text-bad-500',
                          )}
                        >
                          {e.status.toLowerCase()}
                        </span>
                        <span className="tnum ml-auto text-xs text-mist-500">
                          {ms(e.duration_ms)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-mist-500">
                        {e.worker ? `on ${e.worker.name} · ` : ''}
                        <Ago at={e.started_at} />
                      </div>
                      {e.status === 'ABANDONED' && (
                        <div className="mt-1 text-xs text-warn-500">
                          The worker stopped responding; this attempt was recovered automatically.
                        </div>
                      )}
                      {e.error_message && (
                        <div className="mt-1.5 rounded border border-bad-500/20 bg-bad-500/5 px-2 py-1.5">
                          <div className="mono text-[11px] text-bad-500">{e.error_code}</div>
                          <div className="mt-0.5 text-xs break-words text-mist-400">
                            {e.error_message}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <div className="border-b border-ink-800 px-4 py-3">
              <h2 className="text-sm font-semibold">Payload</h2>
            </div>
            <pre className="mono max-h-56 overflow-auto p-4 text-xs text-mist-300">
              {JSON.stringify(d.payload, null, 2)}
            </pre>
          </Card>

          <Card>
            <div className="border-b border-ink-800 px-4 py-3">
              <h2 className="text-sm font-semibold">Logs</h2>
            </div>
            <div className="max-h-72 overflow-auto p-4">
              {(logs.data?.data ?? []).length === 0 ? (
                <Empty title="No log lines" />
              ) : (
                <div className="flex flex-col gap-1">
                  {(logs.data?.data ?? []).map((l) => (
                    <div key={l.id} className="mono flex gap-2 text-[11px]">
                      <span className="shrink-0 text-mist-600">
                        {new Date(l.logged_at).toLocaleTimeString()}
                      </span>
                      <span
                        className={cx(
                          'w-10 shrink-0',
                          l.level === 'ERROR'
                            ? 'text-bad-500'
                            : l.level === 'WARN'
                              ? 'text-warn-500'
                              : 'text-mist-500',
                        )}
                      >
                        {l.level}
                      </span>
                      <span className="break-words text-mist-300">{l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

interface LogLine {
  id: string;
  level: string;
  message: string;
  logged_at: string;
}
