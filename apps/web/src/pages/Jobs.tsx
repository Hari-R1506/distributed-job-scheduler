import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Job, type JobStatus, type Page, type Queue } from '../lib/api';
import {
  Ago,
  Button,
  Card,
  Empty,
  ErrorBox,
  Spinner,
  StatusBadge,
  cx,
  inputCls,
  shortId,
} from '../components/ui';

const STATUSES: JobStatus[] = [
  'QUEUED',
  'SCHEDULED',
  'RUNNING',
  'RETRYING',
  'COMPLETED',
  'DEAD_LETTER',
  'FAILED',
  'CANCELLED',
];

export function Jobs({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [statuses, setStatuses] = useState<JobStatus[]>([]);
  const [queueId, setQueueId] = useState('');
  const [search, setSearch] = useState('');
  // Cursor stack, so Back walks the exact pages already visited. Keyset
  // pagination has no "page N" to jump to — you can only step.
  const [cursors, setCursors] = useState<string[]>([]);

  const cursor = cursors[cursors.length - 1];

  const queues = useQuery({
    queryKey: ['queues', projectId],
    queryFn: () => api.get<{ data: Queue[] }>(`/projects/${projectId}/queues`),
  });

  const params = new URLSearchParams();
  if (statuses.length > 0) params.set('status', statuses.join(','));
  if (queueId) params.set('queue_id', queueId);
  if (search.trim()) params.set('search', search.trim());
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '25');

  const jobs = useQuery({
    queryKey: ['jobs', projectId, params.toString()],
    queryFn: () => api.get<Page<Job>>(`/projects/${projectId}/jobs?${params.toString()}`),
    refetchInterval: 5_000,
    // Keeps the table on screen while a filter change refetches, instead of
    // collapsing to a spinner and losing the reader's place.
    placeholderData: (prev) => prev,
  });

  function toggleStatus(s: JobStatus): void {
    setCursors([]);
    setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={cx(inputCls, 'w-56')}
            placeholder="Job id or handler…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursors([]);
            }}
          />
          <select
            className={inputCls}
            value={queueId}
            onChange={(e) => {
              setQueueId(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">All queues</option>
            {(queues.data?.data ?? []).map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>

          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={cx(
                  'rounded px-2 py-1 text-xs transition-colors',
                  statuses.includes(s)
                    ? 'bg-signal-500/20 text-signal-400'
                    : 'bg-ink-850 text-mist-500 hover:text-mist-300',
                )}
              >
                {s.replace('_', ' ').toLowerCase()}
              </button>
            ))}
          </div>

          {(statuses.length > 0 || queueId || search) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatuses([]);
                setQueueId('');
                setSearch('');
                setCursors([]);
              }}
            >
              Clear
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2 text-xs text-mist-500">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-signal-500" />
            live
          </div>
        </div>
      </Card>

      <Card>
        {jobs.isError && (
          <div className="p-4">
            <ErrorBox error={jobs.error} />
          </div>
        )}
        {jobs.isLoading && <Spinner />}

        {jobs.data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-xs text-mist-500">
                    <th className="px-4 py-2 font-medium">Job</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Handler</th>
                    <th className="px-4 py-2 text-right font-medium">Priority</th>
                    <th className="px-4 py-2 text-right font-medium">Attempts</th>
                    <th className="px-4 py-2 font-medium">Error</th>
                    <th className="px-4 py-2 text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.data.data.map((j) => (
                    <tr
                      key={j.id}
                      className="border-b border-ink-850 last:border-0 hover:bg-ink-850/60"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/jobs/${j.id}`}
                          className="mono text-xs text-signal-500 hover:text-signal-400"
                        >
                          {shortId(j.id)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={j.status} />
                      </td>
                      <td className="px-4 py-2.5 text-mist-300">{j.handler ?? '—'}</td>
                      <td className="tnum px-4 py-2.5 text-right text-mist-400">{j.priority}</td>
                      <td className="tnum px-4 py-2.5 text-right text-mist-400">
                        {j.attempt_count}
                        {j.max_attempts ? `/${j.max_attempts}` : ''}
                      </td>
                      {/* last_error_code is denormalised onto the job precisely
                          so this column needs no extra query per row. */}
                      <td className="max-w-[16rem] truncate px-4 py-2.5 text-xs text-bad-500">
                        {j.last_error_code ?? ''}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Ago at={j.created_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {jobs.data.data.length === 0 && (
              <Empty
                title="No jobs match these filters"
                hint="Clear the filters, or create a job from the API docs at /docs."
              />
            )}

            <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
              <span className="text-xs text-mist-500">
                {jobs.data.data.length} shown
                {jobs.data.page.has_more ? ' · more available' : ''}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={!jobs.data.page.next_cursor}
                  onClick={() => {
                    const next = jobs.data?.page.next_cursor;
                    if (next) setCursors((c) => [...c, next]);
                    void qc.invalidateQueries({ queryKey: ['jobs'] });
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
