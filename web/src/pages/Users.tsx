import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { AuthUser, Role } from '../api.ts';
import { useAuth, isAdmin } from '../auth.tsx';
import { Empty, ErrorBox, Field, Loading, formatTime } from '../ui.tsx';

type Row = AuthUser & { createdAt: string };

export function UsersPage() {
  const { user: me } = useAuth();
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listUsers();
      setItems(r.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isAdmin(me?.role)) {
    return <div className="center">需要管理员权限。</div>;
  }

  return (
    <>
      <NewUserCard onCreated={load} />
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty label="还没有用户" />
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>用户名</th>
                <th>姓名</th>
                <th>邮箱</th>
                <th style={{ width: 90 }}>角色</th>
                <th style={{ width: 140 }}>创建时间</th>
                <th style={{ width: 260 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <UserRow
                  key={u.id}
                  row={u}
                  isSelf={u.id === me?.id}
                  onChanged={load}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function UserRow({
  row,
  isSelf,
  onChanged,
  onError,
}: {
  row: Row;
  isSelf: boolean;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(row.username);
  const [name, setName] = useState(row.name);
  const [email, setEmail] = useState(row.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError(null);
    try {
      const patch: Record<string, unknown> = { username, name, email };
      if (password) patch.password = password;
      await api.updateUser(row.id, patch);
      setEditing(false);
      setPassword('');
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(role: Role) {
    onError(null);
    try {
      await api.updateUser(row.id, { role });
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  async function remove() {
    if (!confirm(`删除用户 ${row.name}？其名下工单的负责人会被置空。`)) return;
    onError(null);
    try {
      await api.deleteUser(row.id);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  if (editing) {
    return (
      <tr>
        <td className="muted">{row.id}</td>
        <td>
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%' }} />
        </td>
        <td>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        </td>
        <td>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
        </td>
        <td>
          <select value={row.role} onChange={(e) => void changeRole(e.target.value as Role)}>
            <option value="agent">agent</option>
            <option value="admin">admin</option>
          </select>
        </td>
        <td />
        <td>
          <div className="row">
            <input
              type="password"
              placeholder="新密码（留空不改）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: 130 }}
            />
            <button className="primary" onClick={save} disabled={busy}>
              保存
            </button>
            <button onClick={() => setEditing(false)}>取消</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="muted">{row.id}</td>
      <td className="mono small">{row.username}</td>
      <td>
        {row.name}
        {isSelf && <span className="pill closed" style={{ marginLeft: 8 }}>我</span>}
      </td>
      <td className="small">{row.email}</td>
      <td>
        <span className={`pill ${row.role === 'admin' ? 'open' : 'closed'}`}>{row.role}</span>
      </td>
      <td className="small muted">{formatTime(row.createdAt)}</td>
      <td>
        <div className="row">
          <button onClick={() => setEditing(true)}>编辑</button>
          {row.role === 'admin' ? (
            <button onClick={() => void changeRole('agent')}>降为 agent</button>
          ) : (
            <button onClick={() => void changeRole('admin')}>升为 admin</button>
          )}
          <button className="danger" onClick={remove}>
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

function NewUserCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser({ username, name, email, password: password || undefined, role });
      setUsername('');
      setName('');
      setEmail('');
      setPassword('');
      setRole('agent');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="card">
        <button className="primary" onClick={() => setOpen(true)}>
          新建用户
        </button>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>新建用户</h2>
      <ErrorBox error={error} />
      <div className="row">
        <div style={{ flex: 1, minWidth: 140 }}>
          <Field label="用户名">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{ width: '100%' }}
              required
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="姓名">
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} required />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Field label="邮箱">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%' }}
              required
            />
          </Field>
        </div>
        <div style={{ width: 160 }}>
          <Field label="初始密码">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%' }}
            />
          </Field>
        </div>
        <div style={{ width: 110 }}>
          <Field label="角色">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: '100%' }}>
              <option value="agent">agent</option>
              <option value="admin">admin</option>
            </select>
          </Field>
        </div>
      </div>
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '创建中…' : '创建'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}
