import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { MenuRow, Permission } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import { Empty, ErrorBox, ConfirmButton, Drawer, Field, Loading, PageHead } from '../ui.tsx';
import { PERMISSION_LABEL, ORDER } from './Roles.tsx';

/**
 * Menu management. The top-bar tabs are rows in the `menus` table, so this page
 * is where they are named, ordered, shown or hidden, and scoped to a
 * permission.
 *
 * A menu with no permission is visible to every signed-in user. That is not a
 * weaker check than a permission — it is the explicit "everyone" case, and the
 * client renders the server's already-filtered list, so this page and the nav
 * cannot disagree about who sees what.
 */
export function MenusPage() {
  const { permissions, reloadMenus } = useAuth();
  const [items, setItems] = useState<MenuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  /**
   * Reloading also refreshes the top bar, so a rename, reorder, or hide is
   * visible in the nav immediately rather than after the next full page load.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listAllMenus();
      setItems(r.items);
      await reloadMenus();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [reloadMenus]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!can(permissions, 'menus.manage')) {
    return <div className="center">需要菜单管理权限。</div>;
  }

  /**
   * Reordering rewrites `sort` for the whole list (`(index + 1) * 10`) rather
   * than swapping two values. Swapping only works while the values are
   * distinct; a custom menu created at the same `sort` as a built-in one would
   * make a swap a no-op. Renormalizing is idempotent and leaves gaps for a
   * later manual insert.
   */
  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;

    const next = [...items];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;

    const changed = next
      .map((m, i) => ({ id: m.id, sort: (i + 1) * 10 }))
      .filter((m) => m.sort !== items.find((o) => o.id === m.id)?.sort);

    setBusyId(a.id);
    setError(null);
    try {
      await Promise.all(changed.map((m) => api.updateMenu(m.id, { sort: m.sort })));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHead title="菜单" sub={`共 ${items.length} 个菜单`}>
        <button className="primary" onClick={() => setCreating(true)}>
          新建菜单
        </button>
      </PageHead>

      {creating && (
        <NewMenuDrawer
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      <ErrorBox error={error} />
      <div className="card">
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty label="还没有菜单" />
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th style={{ width: 140 }}>名称</th>
                <th style={{ width: 110 }}>标识</th>
                <th style={{ width: 160 }}>路径</th>
                <th>可见条件</th>
                <th style={{ width: 70 }}>排序</th>
                <th style={{ width: 260 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, i) => (
                <MenuRowView
                  key={m.id}
                  row={m}
                  first={i === 0}
                  last={i === items.length - 1}
                  busy={busyId === m.id}
                  onMove={(dir) => void move(i, dir)}
                  onChanged={load}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        顶部导航来自这张表：隐藏的菜单不显示，限制了权限的菜单只对该权限的账号显示。
        内置菜单的路径与权限由代码维护，不能删除，但可以改名、排序和隐藏。
      </p>
    </>
  );
}

/** Human-readable summary of who a menu is for. */
function audience(permission: Permission | null): string {
  return permission ? PERMISSION_LABEL[permission] : '所有登录用户';
}

function MenuRowView({
  row,
  first,
  last,
  busy,
  onMove,
  onChanged,
  onError,
}: {
  row: MenuRow;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  async function remove() {
    onError(null);
    try {
      await api.deleteMenu(row.id);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <tr style={row.visible ? undefined : { opacity: 0.55 }}>
        <td className="muted">{row.id}</td>
        <td>
          {row.label}
          {row.isSystem && (
            <span className="pill closed" style={{ marginLeft: 8 }}>
              内置
            </span>
          )}
          {!row.visible && (
            <span className="pill closed" style={{ marginLeft: 8 }}>
              已隐藏
            </span>
          )}
        </td>
        <td className="mono small">{row.name}</td>
        <td className="mono small">{row.path}</td>
        <td className="small">{audience(row.permission)}</td>
        <td className="small muted">{row.sort}</td>
        <td>
          <div className="row">
            <button onClick={() => onMove(-1)} disabled={first || busy} aria-label="上移">
              ↑
            </button>
            <button onClick={() => onMove(1)} disabled={last || busy} aria-label="下移">
              ↓
            </button>
            <button onClick={() => setEditing(true)}>编辑</button>
            {row.isSystem ? (
              <span className="muted small">不可删除</span>
            ) : (
              <ConfirmButton label="删除" question="确认删除？" onConfirm={remove} />
            )}
          </div>
        </td>
      </tr>
      {editing && (
        <EditMenuDrawer
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

function PermissionSelect({
  value,
  onChange,
  disabled,
}: {
  value: Permission | null;
  onChange: (next: Permission | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || null) as Permission | null)}
      style={{ width: '100%' }}
      disabled={disabled}
    >
      <option value="">所有登录用户</option>
      {ORDER.map((p) => (
        <option key={p} value={p}>
          {PERMISSION_LABEL[p]}
        </option>
      ))}
    </select>
  );
}

function EditMenuDrawer({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: MenuRow;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [path, setPath] = useState(row.path);
  const [permission, setPermission] = useState<Permission | null>(row.permission);
  const [sort, setSort] = useState(row.sort);
  const [visible, setVisible] = useState(row.visible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const patch: Record<string, unknown> = { label, sort, visible };
      /**
       * A built-in tab's route and permission are the binding between the nav
       * and the page it opens; the server pins both and the seed reconciles
       * them on boot. Sending them would be a change that never persists, so
       * the form does not offer it either.
       */
      if (!row.isSystem) {
        patch.path = path;
        patch.permission = permission;
      }
      await api.updateMenu(row.id, patch);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`编辑菜单 · ${row.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="edit-menu-form" disabled={busy || !label.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="edit-menu-form" onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="标识">
          <div className="mono muted" style={{ padding: '6px 0' }}>
            {row.name}
          </div>
        </Field>
        <Field label="名称">
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: '100%' }} required />
        </Field>
        <Field label="路径">
          {row.isSystem ? (
            <div className="mono muted" style={{ padding: '6px 0' }}>
              {row.path}
            </div>
          ) : (
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/reports"
              style={{ width: '100%' }}
              required
            />
          )}
        </Field>
        <Field label="可见条件">
          {row.isSystem ? (
            <div className="small muted" style={{ padding: '6px 0' }}>
              {audience(row.permission)}（内置菜单的权限由代码维护）
            </div>
          ) : (
            <PermissionSelect value={permission} onChange={setPermission} />
          )}
        </Field>
        <Field label="排序（数字越小越靠前）">
          <input
            type="number"
            value={sort}
            onChange={(e) => setSort(Number(e.target.value))}
            style={{ width: '100%', maxWidth: 160 }}
          />
        </Field>
        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => setVisible(e.target.checked)}
            style={{ width: 'auto' }}
          />
          在顶部导航显示
        </label>
      </form>
    </Drawer>
  );
}

function NewMenuDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [permission, setPermission] = useState<Permission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createMenu({ name, label, path, permission });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="新建菜单"
      onClose={onClose}
      footer={
        <>
          <button
            className="primary"
            type="submit"
            form="new-menu-form"
            disabled={busy || !name.trim() || !label.trim() || !path.trim()}
          >
            {busy ? '创建中…' : '创建'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="new-menu-form" onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="名称">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: '100%' }}
            autoFocus
            required
          />
        </Field>
        <Field label="标识（英文，创建后不可改）">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. reports"
            style={{ width: '100%' }}
            required
          />
        </Field>
        <Field label="路径">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/reports"
            style={{ width: '100%' }}
            required
          />
        </Field>
        <Field label="可见条件">
          <PermissionSelect value={permission} onChange={setPermission} />
        </Field>
        <p className="muted small">
          自定义菜单的路径需要是一个客户端已存在的页面，否则点击后显示「页面不存在」。
        </p>
      </form>
    </Drawer>
  );
}
