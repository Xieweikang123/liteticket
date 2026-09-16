import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { AuthUser, RoleRow } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import { Empty, ErrorBox, ConfirmButton, Drawer, Field, Loading, PageHead, formatTime } from '../ui.tsx';

type Row = AuthUser & { createdAt: string };

export function UsersPage() {
  const { user: me, permissions } = useAuth();
  const [items, setItems] = useState<Row[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const manage = can(permissions, 'users.manage');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([api.listUsers(), api.listRoles()]);
      setItems(u.items);
      setRoles(r.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!can(permissions, 'users.read')) {
    return <div className="center">需要用户查看权限。</div>;
  }

  const roleLabel = new Map(roles.map((r) => [r.name, r.label]));

  return (
    <>
      <PageHead title="用户" sub={`共 ${items.length} 个用户`}>
        {manage && (
          <button className="primary" onClick={() => setCreating(true)}>
            新建用户
          </button>
        )}
      </PageHead>

      {creating && (
        <NewUserDrawer
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

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
                <th style={{ width: 110 }}>角色</th>
                <th style={{ width: 140 }}>创建时间</th>
                {manage && <th style={{ width: 320 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <UserRow
                  key={u.id}
                  row={u}
                  roles={roles}
                  roleLabel={roleLabel}
                  canManage={manage}
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
  roles,
  roleLabel,
  canManage,
  isSelf,
  onChanged,
  onError,
}: {
  row: Row;
  roles: RoleRow[];
  roleLabel: Map<string, string>;
  canManage: boolean;
  isSelf: boolean;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  async function remove() {
    onError(null);
    try {
      await api.deleteUser(row.id);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <tr>
        <td className="muted">{row.id}</td>
        <td className="mono small">{row.username}</td>
        <td>
          {row.name}
          {isSelf && (
            <span className="pill closed" style={{ marginLeft: 8 }}>
              我
            </span>
          )}
        </td>
        <td className="small">{row.email}</td>
        <td>
          <span className={`pill ${row.role === 'admin' ? 'open' : 'closed'}`}>
            {roleLabel.get(row.role) ?? row.role}
          </span>
        </td>
        <td className="small muted">{formatTime(row.createdAt)}</td>
        {canManage && (
          <td>
            <div className="row">
              <button onClick={() => setEditing(true)}>编辑</button>
              <ConfirmButton
                label="删除"
                question="确认删除？"
                onConfirm={remove}
              />
            </div>
          </td>
        )}
      </tr>
      {editing && (
        <EditUserDrawer
          row={row}
          roles={roles}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onError={onError}
        />
      )}
    </>
  );
}

function EditUserDrawer({
  row,
  roles,
  onClose,
  onSaved,
  onError,
}: {
  row: Row;
  roles: RoleRow[];
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [username, setUsername] = useState(row.username);
  const [name, setName] = useState(row.name);
  const [email, setEmail] = useState(row.email);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(row.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const patch: Record<string, unknown> = { username, name, email, role };
      if (password) patch.password = password;
      await api.updateUser(row.id, patch);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`编辑用户 · ${row.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="edit-user-form" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="用户名">
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%' }} required />
        </Field>
        <Field label="姓名">
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} required />
        </Field>
        <Field label="邮箱">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%' }}
            required
          />
        </Field>
        <Field label="角色">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: '100%' }}>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="新密码（留空不改）">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
            autoComplete="new-password"
          />
        </Field>
      </form>
    </Drawer>
  );
}

/**
 * The built-in `agent` is the sensible default for a new account and sorts
 * after the system roles, so pick it by name rather than by position.
 */
function defaultRole(roles: RoleRow[]): string {
  return roles.find((r) => r.name === 'agent')?.name ?? roles[0]?.name ?? 'agent';
}

function NewUserDrawer({
  roles,
  onClose,
  onCreated,
}: {
  roles: RoleRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(defaultRole(roles));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser({ username, name, email, password: password || undefined, role });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="新建用户"
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="new-user-form" disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="new-user-form" onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="用户名">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ width: '100%' }}
            autoFocus
            required
          />
        </Field>
        <Field label="姓名">
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} required />
        </Field>
        <Field label="邮箱">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%' }}
            required
          />
        </Field>
        <Field label="初始密码">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
            autoComplete="new-password"
          />
        </Field>
        <Field label="角色">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: '100%' }}>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Drawer>
  );
}
