import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Overview as OverviewData, type Queue, type Worker } from '../lib/api';
import { Card, Empty, HealthDot, Spinner, Stat, cx, ms, secs } from '../components/ui';

interface ThroughputPoint {
  bucket: string;
  completed: number;
  failed: number;
  dead_lettered: number;
}

export function Overview({ projectId, orgId }: { projectId: string; orgId: string }) {
  // Cadences are tuned per view rather than "poll everything at 1s": the stat
  // cards change constantly, the chart's underlying rollup only advances once a
  // minute, so polling it faster would show nothing new at real cost.
  const overview = useQuery({
    queryKey: ['overview', projectId],
    queryFn: () => api.get<OverviewData>(`/projects/${projectId}/metrics/overview`),
    refetchInterval: 5_000,
  });

  const throughput = useQuery({
    queryKey: ['throughput', projectId],
    queryFn: () =>
      api.get<{ data: ThroughputPoint[] }>(
        `/projects/${projectId}/metrics/throughput?window=1h&bucket=1m`,
      ),
    refetchInterval: 30_000,
  });

  const queues = useQuery({
    queryKey: ['queues', projectId],
    queryFn: () => api.get<{ data: Queue[] }>(`/projects/${projectId}/queues`),
    refetchInterval: 5_000,
  });

  const workers = useQuery({
    queryKey: ['workers', orgId],
    queryFn: () => api.get<{ data: Worker[] }>(`/orgs/${orgId}/workers`),
    refetchInterval: 5_000,
  });

  if (overview.isLoading) return <Spinner />;
  const d = overview.data;
  if (!d) return null;

  const oldest = d.oldest_queued_age_s;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Queued" value={d.queued} tone={d.queued > 0 ? 'accent' : 'neutral'} />
        <Stat label="Running" value={d.running} sub={d.capacity_used} tone="accent" />
        <Stat label="Scheduled" value={d.scheduled} sub="future work" />
        <Stat
          label="Retrying"
          value={d.retrying}
          tone={d.retrying > 0 ? 'warn' : 'neutral'}
          sub="in backoff"
        />
        <Stat label="Completed 24h" value={d.completed_24h.toLocaleString()} tone="good" />
        <Stat
          label="DLQ open"
          value={d.dlq_open}
          tone={d.dlq_open > 0 ? 'bad' : 'neutral'}
          sub="needs a human"
        />
        <Stat
          label="Success rate"
          value={d.success_rate_24h === null ? '—' : `${(d.success_rate_24h * 100).toFixed(1)}%`}
          tone={
            d.success_rate_24h === null
              ? 'neutral'
              : d.success_rate_24h > 0.98
                ? 'good'
                : d.success_rate_24h > 0.9
                  ? 'warn'
                  : 'bad'
          }
          sub="of terminal jobs"
        />
        {/*
          The single best SLO proxy in the system. If this climbs, something is
          wrong regardless of what every other number says — a queue draining
          10,000 jobs fast is healthy; one with 5 jobs stuck for an hour is not.
        */}
        <Stat
          label="Oldest queued"
          value={secs(oldest)}
          tone={oldest === null ? 'neutral' : oldest > 300 ? 'bad' : oldest > 60 ? 'warn' : 'good'}
          sub="best health signal"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Throughput</h2>
            <span className="text-xs text-mist-500">
              last hour · per minute · avg {ms(d.avg_duration_ms)} · p95 ~
              {ms(d.p95_duration_ms_approx)}
            </span>
          </div>
          <ThroughputChart points={throughput.data?.data ?? []} />
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Workers</h2>
            <Link to="/workers" className="text-xs text-signal-500 hover:text-signal-400">
              View all
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            {(workers.data?.data ?? []).slice(0, 6).map((w) => (
              <div key={w.id} className="flex items-center justify-between text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <HealthDot health={w.health} />
                  <span className="truncate text-mist-100">{w.name}</span>
                </div>
                <span className="tnum shrink-0 text-xs text-mist-500">
                  {w.active_job_count}/{w.concurrency}
                </span>
              </div>
            ))}
            {(workers.data?.data ?? []).length === 0 && (
              <Empty
                title="No workers registered"
                hint="Start one with: docker compose up -d worker-1"
              />
            )}
          </div>
          {d.workers_dead > 0 && (
            <div className="mt-3 rounded border border-bad-500/30 bg-bad-500/10 px-2.5 py-1.5 text-xs text-bad-500">
              {d.workers_dead} worker{d.workers_dead > 1 ? 's' : ''} died recently — their jobs were
              recovered automatically.
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div className="border-b border-ink-800 px-4 py-3">
          <h2 className="text-sm font-semibold">Queue health</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-left text-xs text-mist-500">
                <th className="px-4 py-2 font-medium">Queue</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 text-right font-medium">Depth</th>
                <th className="px-4 py-2 text-right font-medium">Running</th>
                <th className="px-4 py-2 text-right font-medium">Oldest</th>
                <th className="px-4 py-2 text-right font-medium">Success 24h</th>
                <th className="px-4 py-2 text-right font-medium">p95</th>
                <th className="px-4 py-2 text-right font-medium">DLQ</th>
              </tr>
            </thead>
            <tbody>
              {(queues.data?.data ?? []).map((q) => (
                <tr key={q.id} className="border-b border-ink-850 last:border-0 hover:bg-ink-850/60">
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/queues/${q.id}`}
                      className="font-medium text-mist-100 hover:text-signal-500"
                    >
                      {q.name}
                    </Link>
                    {q.is_paused && (
                      <span className="ml-2 rounded bg-warn-500/15 px-1.5 py-0.5 text-[10px] font-medium text-warn-500">
                        PAUSED
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <HealthDot health={q.stats?.health ?? 'healthy'} />
                  </td>
                  <td className="tnum px-4 py-2.5 text-right">{q.stats?.queued ?? 0}</td>
                  <td className="tnum px-4 py-2.5 text-right text-mist-400">
                    {q.stats?.capacity_used ?? '—'}
                  </td>
                  <td
                    className={cx(
                      'tnum px-4 py-2.5 text-right',
                      (q.stats?.oldest_queued_age_s ?? 0) > 60 ? 'text-warn-500' : 'text-mist-400',
                    )}
                  >
                    {secs(q.stats?.oldest_queued_age_s)}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-mist-400">
                    {q.stats?.success_rate_24h === null || q.stats?.success_rate_24h === undefined
                      ? '—'
                      : `${(q.stats.success_rate_24h * 100).toFixed(0)}%`}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-mist-400">
                    {ms(q.stats?.p95_duration_ms)}
                  </td>
                  <td
                    className={cx(
                      'tnum px-4 py-2.5 text-right',
                      (q.stats?.dlq_open ?? 0) > 0 ? 'text-bad-500' : 'text-mist-500',
                    )}
                  >
                    {q.stats?.dlq_open ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(queues.data?.data ?? []).length === 0 && (
            <Empty title="No queues yet" hint="Run `npm run seed` to create demo queues." />
          )}
        </div>
      </Card>
    </div>
  );
}

function ThroughputChart({ points }: { points: ThroughputPoint[] }) {
  if (points.length === 0) {
    return (
      <Empty
        title="No throughput data yet"
        hint="Metrics are rolled up once a minute, so the first points appear about a minute after jobs start completing."
      />
    );
  }

  const data = points.map((p) => ({
    t: new Date(p.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    completed: p.completed,
    failed: p.failed,
    dead: p.dead_lettered,
  }));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="gOk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gBad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f87171" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#f87171" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="#252b3a" vertical={false} />
          <XAxis dataKey="t" tick={{ fill: '#6b7488', fontSize: 11 }} stroke="#252b3a" minTickGap={40} />
          <YAxis tick={{ fill: '#6b7488', fontSize: 11 }} stroke="#252b3a" width={44} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: '#141822',
              border: '1px solid #252b3a',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: '#aab2c4' }}
          />
          <Area
            type="monotone"
            dataKey="completed"
            stackId="1"
            stroke="#34d399"
            fill="url(#gOk)"
            strokeWidth={1.5}
          />
          <Area
            type="monotone"
            dataKey="failed"
            stackId="1"
            stroke="#fbbf24"
            fill="none"
            strokeWidth={1.5}
          />
          <Area
            type="monotone"
            dataKey="dead"
            stackId="1"
            stroke="#f87171"
            fill="url(#gBad)"
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
