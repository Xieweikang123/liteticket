import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ErrorBox, Field } from '../ui.tsx';

/** Only allow same-site absolute paths, so `next` cannot become an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Redirect an already-authenticated visitor.
   *
   * This must live in an effect, not in the render body: navigating during
   * render mutates the router's state while React is still rendering this
   * component, which React reports as "Cannot update a component while
   * rendering a different component".
   */
  useEffect(() => {
    if (user) navigate(next, { replace: true });
  }, [user, next, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ maxWidth: 380, margin: '60px auto' }} onSubmit={onSubmit}>
      <h2 style={{ marginTop: 0 }}>登录 liteticket</h2>
      <ErrorBox error={error} />
      <Field label="邮箱">
        <input
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '100%' }}
          autoFocus
          required
        />
      </Field>
      <Field label="密码">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%' }}
          required
        />
      </Field>
      <button className="primary" type="submit" style={{ width: '100%' }} disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
