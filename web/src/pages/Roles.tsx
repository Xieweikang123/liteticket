import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { Permission, RoleRow } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import { Empty, ErrorBox, ConfirmButton, Drawer, Field, Loading, formatTime } from '../ui.tsx';

/** Chinese labels for the fixed permission catalog. */
const PERMISSION_LABEL: Record<Permission, string> = {
  'tickets.read': '查看工单',
  'tickets.write': '处理工单',
  'tickets.delete': '删除工单',
  'users.read': '查看用户',
  'users.manage': '管理用户',
  'roles.manage': '管理角色',
};

const ORDER: Permission[] = [
  'tickets.read',
  'tickets.write',
  'tickets.delete',
  'users.read',
  'users.manage',
  'roles.manage',
];

export function RolesPage() {
  const { permissions } = useAuth();
  const [items, setItems] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const manage = can(permissions, 'roles.manage');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listRoles();
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

  if (!can(permissions, 'users.read')) {
    return <div className="center">需要用户查看权限。</div>;
  }

  return (
    <>
      {manage && <NewRoleCard onCreated={load} />}
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty label="还没有角色" />
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th style={{ width: 120 }}>角色</th>
                <th style={{ width: 100 }}>标识</th>
                <th>权限</th>
                <th style={{ width: 140 }}>创建时间</th>
                {manage && <th style={{ width: 260 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <RoleRowView key={r.id} row={r} canManage={manage} onChanged={load} onError={setError} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        角色决定用户能做什么，服务器在每次请求时按角色实时校验权限。内置角色由代码维护，不能编辑或删除。
      </p>
    </>
  );
}

function PermissionChecklist({
  value,
  onChange,
  disabled,
}: {
  value: Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}) {
  function toggle(p: Permission, on: boolean) {
    onChange(on ? [...value, p] : value.filter((x) => x !== p));
  }

  return (
    <div className="row" style={{ gap: '6px 14px' }}>
      {ORDER.map((p) => (
        <label key={p} className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={value.includes(p)}
            disabled={disabled}
            onChange={(e) => toggle(p, e.target.checked)}
            style={{ width: 'auto' }}
          />
          {PERMISSION_LABEL[p]}
        </label>
      ))}
    </div>
  );
}

function RoleRowView({
  row,
  canManage,
  onChanged,
  onError,
}: {
  row: RoleRow;
  canManage: boolean;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  async function remove() {
    onError(null);
    try {
      await api.deleteRole(row.id);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <tr>
        <td className="muted">{row.id}</td>
        <td>
          {row.label}
          {row.isSystem && (
            <span className="pill closed" style={{ marginLeft: 8 }}>
              内置
            </span>
          )}
        </td>
        <td className="mono small">{row.name}</td>
        <td>
          <div className="row" style={{ gap: '4px 8px' }}>
            {ORDER.filter((p) => row.permissions.includes(p)).map((p) => (
              <span className="tag" key={p}>
                {PERMISSION_LABEL[p]}
              </span>
            ))}
            {row.permissions.length === 0 && <span className="muted small">无</span>}
          </div>
        </td>
        <td className="small muted">{formatTime(row.createdAt)}</td>
        {canManage && (
          <td>
            <div className="row">
              {row.isSystem ? (
                <span className="muted small">不可编辑</span>
              ) : (
                <>
                  <button onClick={() => setEditing(true)}>编辑</button>
                  <ConfirmButton
                    label="删除"
                    question="确认删除？"
                    onConfirm={remove}
                  />
                </>
              )}
            </div>
          </td>
        )}
      </tr>
      {editing && (
        <EditRoleDrawer
          row={row}
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

function EditRoleDrawer({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: RoleRow;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [description, setDescription] = useState(row.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(row.permissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onError(null);
    try {
      await api.updateRole(row.id, { label, description: description || null, permissions });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`编辑角色 · ${row.label}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="primary"
            type="submit"
            form="edit-role-form"
            disabled={busy || !label.trim()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="edit-role-form" onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="角色标识">
          {/* The machine key is the row's identity — the API cannot change it,
              so it is shown as text rather than a disabled input that implies
              it could be edited under other conditions. */}
          <div className="mono muted" style={{ padding: '6px 0' }}>
            {row.name}
          </div>
        </Field>
        <Field label="显示名称">
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: '100%' }} required />
        </Field>
        <Field label="说明（可选）">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="权限">
          <PermissionChecklist value={permissions} onChange={setPermissions} />
        </Field>
      </form>
    </Drawer>
  );
}

function NewRoleCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>(['tickets.read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function reset() {
    setName('');
    setLabel('');
    setDescription('');
    setPermissions(['tickets.read']);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createRole({ name, label, description: description || null, permissions });
      reset();
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
          新建角色
        </button>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>新建角色</h2>
      <ErrorBox error={error} />
      <div className="row">
        <div style={{ width: 150 }}>
          <Field label="角色标识（英文，创建后不可改）">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. viewer"
              style={{ width: '100%' }}
              required
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Field label="显示名称">
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: '100%' }} required />
          </Field>
        </div>
        <div style={{ flex: 2, minWidth: 200 }}>
          <Field label="说明（可选）">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%' }}
            />
          </Field>
        </div>
      </div>
      <Field label="权限">
        <PermissionChecklist value={permissions} onChange={setPermissions} />
      </Field>
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !name.trim() || !label.trim()}>
          {busy ? '创建中…' : '创建'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}
