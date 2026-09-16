import { useState } from 'react';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Drawer, ErrorBox, Field } from '../ui.tsx';

/**
 * Self-service password change.
 *
 * Before this existed only `users.manage` could set a password, so an agent —
 * who is expected to change the password handed to them — could not.
 *
 * The server revokes every token for the account on success, which logs the
 * user out; the form says so before submitting rather than after.
 */
export function ChangePasswordDrawer({ onClose }: { onClose: () => void }) {
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
      <Drawer title="修改密码" onClose={onClose}>
        <h2>密码已修改</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          出于安全考虑，所有已登录设备都已退出。请使用新密码重新登录。
        </p>
      </Drawer>
    );
  }

  return (
    <Drawer
      title="修改密码"
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="change-password-form" disabled={busy}>
            {busy ? '提交中…' : '修改密码'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="change-password-form" onSubmit={submit}>
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
      </form>
    </Drawer>
  );
}

/**
 * The account page.
 *
 * It used to *be* the password form: a tab in the work nav whose entire content
 * was three fields, and which nothing else could ever join. The form moved into
 * a drawer opened from the user menu in the top bar (it is account
 * housekeeping, not a surface you work in), which leaves this page free to
 * become what the nav implies — one place for the account, starting with the
 * identity read back from the server.
 */
export function AccountPage() {
  const { user, permissions } = useAuth();
  const [changing, setChanging] = useState(false);

  return (
    <>
      <div className="card" style={{ maxWidth: 520 }}>
        <h2>账号</h2>
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
        <div className="row" style={{ marginTop: 4 }}>
          <button className="primary" onClick={() => setChanging(true)}>
            修改密码
          </button>
        </div>
        {changing && <ChangePasswordDrawer onClose={() => setChanging(false)} />}
      </div>
      <p className="muted small">
        账号的姓名、邮箱与角色由管理员在「用户」页维护，这里只提供密码自助修改。
      </p>
    </>
  );
}
