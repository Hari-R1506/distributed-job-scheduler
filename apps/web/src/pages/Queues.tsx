import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Queue } from '../lib/api';
import { Button, Card, Empty, ErrorBox, HealthDot, Spinner, cx, ms, secs } from '../components/ui';

export function Queues({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const queues = useQuery({
    queryKey: ['queues', projectId],
    queryFn: () => api.get<{ data: Queue[] }>(`/projects/${projectId}/queues`),
    refetchInterval: 5_000,
  });

  const toggle = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      api.post(`/queues/${id}/${paused ? 'resume' : 'pause'}`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['queues'] }),
  });

  if (queues.isLoading) return <Spinner />;
  const list = queues.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {toggle.isError && <ErrorBox error={toggle.error} />}

      {list.length === 0 ? (
        <Card>
          <Empty title="No queues" hint="Run `npm run seed` to create the demo queues." />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((q) => {
            const s = q.stats;
            return (
              <Card key={q.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/jobs?queue=${q.id}`}
                        className="font-medium hover:text-signal-500"
                      >
                        {q.name}
                      </Link>
                      {q.is_paused && (
                        <span className="rounded bg-warn-500/15 px-1.5 py-0.5 text-[10px] font-medium text-warn-500">
                          PAUSED
                        </span>
                      )}
                    </div>
                    {q.description && (
                      <p className="mt-1 text-xs text-mist-500">{q.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <HealthDot health={s?.health ?? 'healthy'} />
                    <Button
                      size="sm"
                      onClick={() => toggle.mutate({ id: q.id, paused: q.is_paused })}
                      disabled={toggle.isPending}
                      title={
                        q.is_paused
                          ? 'Resume claiming. Workers are notified immediately.'
                          : 'Stop starting new jobs. Running jobs are NOT killed.'
                      }
                    >
                      {q.is_paused ? 'Resume' : 'Pause'}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-3 text-center">
                  <Metric label="Queued" value={s?.queued ?? 0} tone={s?.queued ? 'accent' : ''} />
                  <Metric label="Running" value={s?.capacity_used ?? '—'} />
                  <Metric
                    label="Oldest"
                    value={secs(s?.oldest_queued_age_s)}
                    tone={(s?.oldest_queued_age_s ?? 0) > 60 ? 'warn' : ''}
                  />
                  <Metric
                    label="DLQ"
                    value={s?.dlq_open ?? 0}
                    tone={(s?.dlq_open ?? 0) > 0 ? 'bad' : ''}
                  />
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-ink-800 pt-3 text-[11px] text-mist-500">
                  <span>
                    concurrency{' '}
                    <span className="tnum text-mist-300">{q.max_concurrency ?? '∞'}</span>
                  </span>
                  <span>
                    retry <span className="text-mist-300">{q.retry_policy?.name ?? '—'}</span> (
                    {q.retry_policy?.strategy.toLowerCase()})
                  </span>
                  <span>
                    default priority <span className="tnum text-mist-300">{q.default_priority}</span>
                  </span>
                  <span>
                    p95 <span className="tnum text-mist-300">{ms(s?.p95_duration_ms)}</span>
                  </span>
                  {!q.dlq_enabled && <span className="text-warn-500">DLQ disabled</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = '',
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div>
      <div
        className={cx(
          'tnum text-lg font-semibold',
          tone === 'accent'
            ? 'text-signal-500'
            : tone === 'warn'
              ? 'text-warn-500'
              : tone === 'bad'
                ? 'text-bad-500'
                : 'text-mist-100',
        )}
      >
        {value}
      </div>
      <div className="text-[10px] tracking-wide text-mist-500 uppercase">{label}</div>
    </div>
  );
}
