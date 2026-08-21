import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type DlqEntry, type Page } from '../lib/api';
import { Ago, Button, Card, Empty, ErrorBox, Spinner, cx, shortId } from '../components/ui';

interface Group {
  error_signature: string | null;
  error_code: string | null;
  sample_message: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
  queues: string[];
}

/**
 * The DLQ is an INBOX, not an error log.
 *
 * Default view is unresolved-only and grouped by error signature, because 400
 * dead-lettered jobs are usually 3 problems. Presenting them as a flat table
 * makes an operator do the clustering by eye.
 */
export function Dlq({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const groups = useQuery({
    queryKey: ['dlq-groups', projectId],
    queryFn: () => api.get<{ data: Group[] }>(`/projects/${projectId}/dlq/groups`),
    refetchInterval: 15_000,
  });

  const entries = useQuery({
    queryKey: ['dlq', projectId],
    queryFn: () => api.get<Page<DlqEntry>>(`/projects/${projectId}/dlq?limit=100`),
    refetchInterval: 15_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['dlq'] });
    void qc.invalidateQueries({ queryKey: ['dlq-groups'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const replay = useMutation({
    mutationFn: (id: string) => api.post<{ id: string }>(`/dlq/${id}/replay`),
    onSuccess: invalidate,
    onError: setError,
  });

  const discard = useMutation({
    mutationFn: (id: string) => api.post(`/dlq/${id}/discard`, {}),
    onSuccess: invalidate,
    onError: setError,
  });

  if (groups.isLoading || entries.isLoading) return <Spinner />;

  const groupList = groups.data?.data ?? [];
  const all = entries.data?.data ?? [];

  if (all.length === 0) {
    return (
      <Card>
        <Empty
          title="Nothing in the dead letter queue"
          hint="Jobs land here only after exhausting their retries, or after a failure classified as permanent. An empty inbox is the goal."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error != null && <ErrorBox error={error} />}

      <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs text-mist-400">
        Every entry here needs a human decision: fix the input and replay, or accept the loss. A
        replay creates a <span className="text-mist-200">new job</span> linked to the original — the
        failure history is never overwritten.
      </div>

      <div className="flex flex-col gap-3">
        {groupList.map((g) => {
          const key = g.error_signature ?? g.error_code ?? 'unknown';
          const isOpen = expanded === key;
          const members = all.filter(
            (e) => (e.error_code ?? 'unknown') === (g.error_code ?? 'unknown'),
          );

          return (
            <Card key={key}>
              <button
                onClick={() => setExpanded(isOpen ? null : key)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ink-850/60"
              >
                <span className="mt-1 rounded bg-bad-500/15 px-2 py-0.5 text-xs font-semibold text-bad-500 tnum">
                  {g.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="mono block text-xs text-bad-500">{g.error_code}</span>
                  <span className="mt-0.5 block truncate text-sm text-mist-300">
                    {g.sample_message ?? 'No message'}
                  </span>
                  <span className="mt-1 block text-xs text-mist-500">
                    {g.queues.join(', ')} · first <Ago at={g.first_seen} /> · last{' '}
                    <Ago at={g.last_seen} />
                  </span>
                </span>
                <span className={cx('mt-1 text-mist-500 transition-transform', isOpen && 'rotate-90')}>
                  ›
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-ink-800">
                  {members.slice(0, 25).map((e) => (
                    <div
                      key={e.id}
                      className="flex flex-wrap items-center gap-3 border-b border-ink-850 px-4 py-2.5 last:border-0"
                    >
                      <Link
                        to={`/jobs/${e.job_id}`}
                        className="mono text-xs text-signal-500 hover:text-signal-400"
                      >
                        {shortId(e.job_id)}
                      </Link>
                      <span className="text-xs text-mist-500">{e.queue.name}</span>
                      <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-mist-400">
                        {e.reason.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <span className="tnum text-xs text-mist-500">
                        {e.total_attempts} attempt{e.total_attempts === 1 ? '' : 's'}
                      </span>
                      <span className="text-xs">
                        <Ago at={e.dead_lettered_at} />
                      </span>
                      <span className="ml-auto flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => replay.mutate(e.id)}
                          disabled={replay.isPending}
                        >
                          Replay
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => discard.mutate(e.id)}
                          disabled={discard.isPending}
                          title="Accept the loss. The record is kept, just removed from triage."
                        >
                          Discard
                        </Button>
                      </span>
                    </div>
                  ))}
                  {members.length > 25 && (
                    <div className="px-4 py-2 text-xs text-mist-500">
                      …and {members.length - 25} more with this signature
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
