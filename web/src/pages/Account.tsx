import { useState } from 'react';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ErrorBox, Field } from '../ui.tsx';

/**
 * Self-service password change.
 *
 * Before this page existed only `users.manage` could set a password, so an
 * agent — who is expected to change the password handed to them — could not.
 * The server revokes every token for the account on success, which logs the
 * user out; the page says so before submitting rather than after.
 */
export function AccountPage() {
  const { user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError(new Error('两次输入的新密码不一致'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      // The change revoked this session's token server-side, so clear local
      // state without a second (dead) logout request.
      setDone(true);
      logout({ revoke: false });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card">
        <h2>密码已修改</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          出于安全考虑，所有已登录设备都已退出。请使用新密码重新登录。
        </p>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 420 }}>
      <h2>修改密码</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {user ? `当前账号：${user.username}` : ''}
      </p>
      <ErrorBox error={error} />
      <Field label="当前密码">
        <input
          id="account-current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          style={{ width: '100%' }}
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="新密码">
        <input
          id="account-new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          style={{ width: '100%' }}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field label="确认新密码">
        <input
          id="account-confirm-password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          style={{ width: '100%' }}
          autoComplete="new-password"
          required
        />
      </Field>
      <p className="muted small">修改成功后需要重新登录。</p>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '提交中…' : '修改密码'}
      </button>
    </form>
  );
}
