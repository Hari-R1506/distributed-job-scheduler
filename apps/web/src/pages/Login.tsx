import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorBox, Field, inputCls } from '../components/ui';

export function Login() {
  const auth = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await auth.login(email, password);
      else await auth.register({ email, password, name, org_name: orgName });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <div className="h-6 w-1.5 rounded-full bg-signal-500" />
            <h1 className="text-lg font-semibold">Job Scheduler</h1>
          </div>
          <p className="mt-1.5 text-sm text-mist-500">
            Reliable background execution across multiple workers.
          </p>
        </div>

        <Card className="p-5">
          <form onSubmit={submit} className="flex flex-col gap-3.5">
            {mode === 'register' && (
              <>
                <Field label="Your name">
                  <input
                    className={inputCls}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                  />
                </Field>
                <Field label="Organization">
                  <input
                    className={inputCls}
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    placeholder="Acme Inc"
                  />
                </Field>
              </>
            )}

            <Field label="Email">
              <input
                className={inputCls}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </Field>

            <Field
              label="Password"
              hint={mode === 'register' ? 'At least 12 characters.' : undefined}
            >
              <input
                className={inputCls}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'register' ? 12 : undefined}
              />
            </Field>

            {error != null && <ErrorBox error={error} />}

            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </Card>

        <button
          className="mt-4 w-full text-center text-xs text-mist-500 hover:text-mist-300"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login'
            ? 'No account? Create one'
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
