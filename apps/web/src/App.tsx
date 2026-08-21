import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Queues } from './pages/Queues';
import { Jobs } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { Workers } from './pages/Workers';
import { Dlq } from './pages/Dlq';
import { Button, Empty, Spinner, cx } from './components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  queue_count: number;
}

export function App() {
  const auth = useAuth();
  const [projectId, setProjectId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: Project[] }>('/projects'),
    enabled: !!auth.user,
  });

  useEffect(() => {
    if (!projectId && projects.data?.data[0]) setProjectId(projects.data.data[0].id);
  }, [projects.data, projectId]);

  if (auth.loading) return <Spinner />;
  if (!auth.user) return <Login />;

  const list = projects.data?.data ?? [];

  return (
    <div className="flex min-h-full flex-col">
      <Header
        projects={list}
        projectId={projectId}
        onSelect={setProjectId}
        orgName={auth.orgName}
        userName={auth.user.name}
        onLogout={() => void auth.logout()}
      />

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5">
        {projects.isLoading ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty
            title="No projects yet"
            hint="Create one via the API at /docs, or run `npm run seed` for demo data."
          />
        ) : !projectId || !auth.orgId ? (
          <Spinner />
        ) : (
          <Routes>
            <Route path="/" element={<Overview projectId={projectId} orgId={auth.orgId} />} />
            <Route path="/queues" element={<Queues projectId={projectId} />} />
            <Route path="/jobs" element={<Jobs projectId={projectId} />} />
            <Route path="/jobs/:jobId" element={<JobDetail />} />
            <Route path="/workers" element={<Workers orgId={auth.orgId} />} />
            <Route path="/dlq" element={<Dlq projectId={projectId} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function Header({
  projects,
  projectId,
  onSelect,
  orgName,
  userName,
  onLogout,
}: {
  projects: Project[];
  projectId: string | null;
  onSelect(id: string): void;
  orgName: string | null;
  userName: string;
  onLogout(): void;
}) {
  const location = useLocation();

  const tabs = [
    { to: '/', label: 'Overview' },
    { to: '/queues', label: 'Queues' },
    { to: '/jobs', label: 'Jobs' },
    { to: '/workers', label: 'Workers' },
    { to: '/dlq', label: 'Dead letter' },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1400px] items-center gap-4 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-1.5 rounded-full bg-signal-500" />
          <span className="text-sm font-semibold">Job Scheduler</span>
        </div>

        {projects.length > 1 && (
          <select
            value={projectId ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            className="rounded border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-mist-300"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <nav className="flex gap-1">
          {tabs.map((t) => {
            const active =
              t.to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(t.to);
            return (
              <NavLink
                key={t.to}
                to={t.to}
                className={cx(
                  'rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-ink-800 text-mist-100'
                    : 'text-mist-500 hover:text-mist-200',
                )}
              >
                {t.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-mist-500 hover:text-signal-500"
          >
            API docs ↗
          </a>
          <span className="hidden text-xs text-mist-500 sm:inline">
            {userName}
            {orgName ? ` · ${orgName}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={onLogout}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
