import { useState } from 'react';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ErrorBox, Field, PageHead } from '../ui.tsx';

/**
 * The account page: identity read back from the server, plus self-service
 * password change.
 *
 * Before this existed only `users.manage` could set a password, so an agent —
 * who is expected to change the password handed to them — could not.
 *
 * The password form lives here rather than in a drawer opened from the top
 * bar. It had been both: a 修改密码 entry in the user menu and a second button
 * on this page opened the same drawer, which meant two controls for one action
 * and an entry point that left the page while its neighbour did not. The page
 * is the account's own surface, so both the facts and the form belong on it,
 * and the menu keeps a single 账号 link.
 *
 * The server revokes every token for the account on success, which logs the
 * user out; the form says so before submitting rather than after.
 */
export function AccountPage() {
  const { user, permissions, logout } = useAuth();
  const [editing, setEditing] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function collapse() {
    setEditing(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    setError(null);
  }

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
      // state without a second (dead) logout request. Clearing the user sends
      // RequireAuth to /login, which is where the new password gets used.
      logout({ revoke: false });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="账号" sub="你的身份信息，以及密码自助修改" />

      <div className="account-grid">
        <div className="card">
          <h2>身份</h2>
          <dl className="facts">
            <dt>用户名</dt>
            <dd>{user?.username ?? '—'}</dd>
            <dt>姓名</dt>
            <dd>{user?.name ?? '—'}</dd>
            <dt>邮箱</dt>
            <dd>{user?.email ?? '—'}</dd>
            <dt>权限</dt>
            <dd>{permissions.length} 项</dd>
          </dl>
          <p className="muted small" style={{ margin: '14px 0 0' }}>
            姓名、邮箱与角色由管理员在「用户」页维护。
          </p>
        </div>

        <form className="card" onSubmit={submit}>
          <div className="card-head">
            <h2>密码</h2>
            {editing ? (
              <button type="button" onClick={collapse}>
                取消
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => setEditing(true)}>
                修改密码
              </button>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            修改成功后所有已登录设备都会退出，请使用新密码重新登录。
          </p>
          {editing && (
            <>
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
              <div className="row">
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? '提交中…' : '修改密码'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </>
  );
}
