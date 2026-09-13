import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ErrorBox } from '../ui.tsx';

/** Only allow same-site absolute paths, so `next` cannot become an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

/** Eye / eye-with-slash, inlined so the page pulls in no icon dependency. */
function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {off && (
        <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const usernameRef = useRef<HTMLInputElement>(null);

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

  /**
   * A failed login should put the cursor where the fix is. The server rejects
   * a wrong password but also an unknown username, so the safest guess is the
   * field the user is least likely to have typed correctly: if the username
   * was never touched it is empty, and that is what gets focus.
   */
  function focusFirstProblem() {
    const input = usernameRef.current;
    if (input && !input.value.trim()) input.focus();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
      focusFirstProblem();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      {/* Decorative only: hidden from assistive tech so a screen reader hears
          the form, not the marketing copy twice. */}
      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-logo">
          <span className="auth-logo-mark">LT</span>
          <span className="auth-logo-word">liteticket</span>
        </div>

        <div className="auth-pitch">
          <h1>把问题记下来，然后解决它。</h1>
          <p>轻量、API 优先的工单系统。一条命令启动，零外部依赖。</p>
        </div>

        <ul className="auth-points">
          <li>
            <strong>统一收件箱</strong>
            <span>待处理 / 进行中 / 已关闭，一眼看清积压</span>
          </li>
          <li>
            <strong>内部备注</strong>
            <span>对外回复与内部讨论分开，不会误发</span>
          </li>
          <li>
            <strong>令牌自助</strong>
            <span>随时签发、随时吊销自己的 API token</span>
          </li>
        </ul>
      </aside>

      <main className="auth-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          <div className="auth-head">
            <div className="auth-logo compact">
              <span className="auth-logo-mark">LT</span>
              <span className="auth-logo-word">liteticket</span>
            </div>
            <h2>欢迎回来</h2>
            <p className="muted small">请使用你的用户名登录以继续。</p>
          </div>

          <ErrorBox error={error} />

          <div className="auth-field">
            <label htmlFor="login-username">用户名</label>
            <div className="auth-control">
              <input
                id="login-username"
                ref={usernameRef}
                type="text"
                name="username"
                autoComplete="username"
                spellCheck={false}
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="login-password">密码</label>
            <div className="auth-control">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={(e) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)}
                required
              />
              <button
                type="button"
                className="auth-reveal"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                <EyeIcon off={showPassword} />
              </button>
            </div>
            {capsLock && <p className="auth-hint">大写锁定已开启</p>}
          </div>

          <button className="primary auth-submit" type="submit" disabled={busy} aria-busy={busy}>
            {busy && <span className="auth-spinner" aria-hidden="true" />}
            {busy ? '登录中…' : '登录'}
          </button>

          <p className="auth-alt small muted">
            还没有账号？请联系管理员为你开通，或使用 API token 访问。
          </p>
        </form>
      </main>
    </div>
  );
}
