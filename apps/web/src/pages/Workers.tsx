import { useQuery } from '@tanstack/react-query';
import { api, type Worker } from '../lib/api';
import { Ago, Card, Empty, HealthDot, Spinner, cx, secs } from '../components/ui';

export function Workers({ orgId }: { orgId: string }) {
  const workers = useQuery({
    queryKey: ['workers', orgId],
    queryFn: () => api.get<{ data: Worker[] }>(`/orgs/${orgId}/workers`),
    refetchInterval: 5_000,
  });

  if (workers.isLoading) return <Spinner />;
  const list = workers.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs text-mist-400">
        Workers register themselves through the <span className="text-mist-200">database</span>, not
        over HTTP — a worker that can only reach Postgres is still fully functional, so the API is
        never on the critical path of job execution. That is why there is no "add worker" button
        here: you start a worker process, and it appears.
      </div>

      {list.length === 0 ? (
        <Card>
          <Empty
            title="No workers registered"
            hint="Start one with: docker compose up -d worker-1 worker-2 worker-3"
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((w) => (
            <Card key={w.id} className={cx('p-4', w.health === 'dead' && 'opacity-60')}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">{w.name}</div>
                  <div className="mono mt-0.5 text-[11px] text-mist-500">{w.hostname}</div>
                </div>
                <HealthDot health={w.health} />
              </div>

              <div className="mt-3">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-mist-500">Slots in use</span>
                  <span className="tnum text-mist-300">
                    {w.active_job_count}/{w.concurrency}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
                  <div
                    className="h-full rounded-full bg-signal-500 transition-all"
                    style={{
                      width: `${Math.min(100, (w.active_job_count / Math.max(1, w.concurrency)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-mist-500">Heartbeat</div>
                  <div
                    className={cx(
                      'tnum mt-0.5',
                      w.seconds_since_heartbeat > 30
                        ? 'text-bad-500'
                        : w.seconds_since_heartbeat > 10
                          ? 'text-warn-500'
                          : 'text-ok-500',
                    )}
                  >
                    {secs(w.seconds_since_heartbeat)} ago
                  </div>
                </div>
                <div>
                  <div className="text-mist-500">Uptime</div>
                  <div className="mt-0.5 text-mist-300">
                    <Ago at={w.started_at} />
                  </div>
                </div>
              </div>

              {w.queues.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {w.queues.map((q) => (
                    <span
                      key={q.id}
                      className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-mist-400"
                    >
                      {q.name}
                    </span>
                  ))}
                </div>
              )}

              {w.health === 'dead' && (
                <div className="mt-3 rounded border border-bad-500/30 bg-bad-500/10 px-2 py-1.5 text-[11px] text-bad-500">
                  Stopped responding. Its in-flight jobs were reclaimed automatically once their
                  leases expired.
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
