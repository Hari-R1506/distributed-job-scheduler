import type { ReactNode } from 'react';
import type { JobStatus } from '../lib/api';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Status is encoded in COLOUR AND SHAPE, not colour alone.
 *
 * A dashboard is scanned, not read: an operator needs "is anything wrong" to
 * land before they parse a single word. Colour alone also fails for the ~8% of
 * men with colour-vision deficiency, so terminal-bad states carry a filled dot
 * and in-flight states carry a pulsing one.
 */
const STATUS_STYLE: Record<JobStatus, { label: string; cls: string; dot: string }> = {
  SCHEDULED: { label: 'Scheduled', cls: 'bg-idle-500/15 text-idle-500', dot: 'bg-idle-500' },
  QUEUED: { label: 'Queued', cls: 'bg-info-500/15 text-info-500', dot: 'bg-info-500' },
  CLAIMED: { label: 'Claimed', cls: 'bg-signal-500/15 text-signal-500', dot: 'bg-signal-500' },
  RUNNING: { label: 'Running', cls: 'bg-signal-500/15 text-signal-500', dot: 'bg-signal-500' },
  RETRYING: { label: 'Retrying', cls: 'bg-warn-500/15 text-warn-500', dot: 'bg-warn-500' },
  COMPLETED: { label: 'Completed', cls: 'bg-ok-500/15 text-ok-500', dot: 'bg-ok-500' },
  FAILED: { label: 'Failed', cls: 'bg-bad-500/15 text-bad-500', dot: 'bg-bad-500' },
  DEAD_LETTER: { label: 'Dead letter', cls: 'bg-bad-500/20 text-bad-500', dot: 'bg-bad-500' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-ink-700 text-mist-400', dot: 'bg-mist-500' },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.QUEUED;
  const live = status === 'RUNNING' || status === 'CLAIMED';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        s.cls,
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot, live && 'live-dot')} />
      {s.label}
    </span>
  );
}

export function HealthDot({ health }: { health: string }) {
  const map: Record<string, string> = {
    healthy: 'bg-ok-500',
    degraded: 'bg-warn-500',
    lagging: 'bg-warn-500',
    unhealthy: 'bg-bad-500',
    dead: 'bg-bad-500',
    paused: 'bg-mist-500',
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cx('h-2 w-2 rounded-full', map[health] ?? 'bg-mist-500')} />
      <span className="text-xs text-mist-300 capitalize">{health}</span>
    </span>
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'rounded-lg border border-ink-800 bg-ink-900 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A stat tile. `tone` carries meaning: an amber "oldest queued" is the single
 * best early warning this system has, and it should look different from a
 * neutral count without the reader consulting a legend.
 */
export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
}) {
  const toneCls = {
    neutral: 'text-mist-100',
    good: 'text-ok-500',
    warn: 'text-warn-500',
    bad: 'text-bad-500',
    accent: 'text-signal-500',
  }[tone];

  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-mist-500 uppercase">{label}</div>
      <div className={cx('tnum mt-1 text-2xl font-semibold', toneCls)}>{value}</div>
      {sub && <div className="tnum mt-0.5 text-xs text-mist-500">{sub}</div>}
    </Card>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const variants = {
    default: 'bg-ink-800 hover:bg-ink-700 text-mist-100 border border-ink-700',
    primary: 'bg-signal-600 hover:bg-signal-500 text-ink-950 font-medium border border-signal-600',
    danger: 'bg-bad-500/10 hover:bg-bad-500/20 text-bad-500 border border-bad-500/30',
    ghost: 'hover:bg-ink-800 text-mist-300 border border-transparent',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variants[variant],
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-mist-300">{label}</span>
      {children}
      {hint && <span className="text-xs text-mist-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm text-mist-100 placeholder:text-mist-500 focus:border-signal-600 focus:outline-none';

// ── Feedback ────────────────────────────────────────────────────────────────

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <div className="text-sm text-mist-300">{title}</div>
      {hint && <div className="max-w-sm text-xs text-mist-500">{hint}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-bad-500/30 bg-bad-500/10 px-4 py-3 text-sm text-bad-500">
      {message}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-700 border-t-signal-500" />
    </div>
  );
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function secs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v < 60) return `${v}s`;
  if (v < 3600) return `${Math.floor(v / 60)}m`;
  if (v < 86_400) return `${Math.floor(v / 3600)}h`;
  return `${Math.floor(v / 86_400)}d`;
}

/** Relative time, with the exact instant in the tooltip. */
export function Ago({ at }: { at: string | null }) {
  if (!at) return <span className="text-mist-500">—</span>;
  const then = new Date(at).getTime();
  const delta = Math.floor((Date.now() - then) / 1000);
  const label =
    delta < 0
      ? `in ${secs(-delta)}`
      : delta < 5
        ? 'just now'
        : `${secs(delta)} ago`;
  return (
    <span className="tnum text-mist-400" title={new Date(at).toLocaleString()}>
      {label}
    </span>
  );
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
