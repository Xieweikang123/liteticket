import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import type { AuthUser, Stats, Ticket } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import {
  Drawer,
  ErrorBox,
  Empty,
  Field,
  Loading,
  PageHead,
  PriorityPill,
  StatusPill,
  formatTime,
} from '../ui.tsx';

const STATUSES = ['open', 'pending', 'closed'];
const PAGE_SIZE = 50;

export function TicketListPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const { permissions } = useAuth();
  const [items, setItems] = useState<Ticket[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const canWrite = can(permissions, 'tickets.write');

  // The search box is local state so typing does not fight the URL on every
  // keystroke; it is pushed to the URL on a debounce.
  const [draft, setDraft] = useState(q);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The edit drawer's assignee picker needs users, but a role may be able
      // to work tickets without being able to list users. Fetch separately so a
      // denied user list leaves the table — and its edit button — usable.
      const [list, stats, u] = await Promise.all([
        api.listTickets({ status, q, tag, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        api.stats(),
        can(permissions, 'users.read') ? api.listUsers() : Promise.resolve({ items: [] }),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setCounts(stats);
      setUsers(u.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [status, q, tag, page, permissions]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // A deep link or a shrunk result set can point past the last page; settle on
  // the real last page instead of showing an empty table.
  useEffect(() => {
    if (loading || page <= pages) return;
    const p = new URLSearchParams(params);
    if (pages <= 1) p.delete('page');
    else p.set('page', String(pages));
    setParams(p, { replace: true });
  }, [loading, page, pages, params, setParams]);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (draft) next.set('q', draft);
      else next.delete('q');
      // A new search term can shrink the result set below the current page.
      next.delete('page');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [draft, q, params, setParams]);

  function setStatus(next: string) {
    const p = new URLSearchParams(params);
    if (next) p.set('status', next);
    else p.delete('status');
    p.delete('page');
    setParams(p, { replace: true });
  }

  function goPage(next: number) {
    const p = new URLSearchParams(params);
    if (next <= 1) p.delete('page');
    else p.set('page', String(next));
    setParams(p, { replace: true });
  }

  return (
    <>
      <PageHead
        title="工单"
        sub={
          counts &&
          `共 ${total} 张 · 待处理 ${counts.open} · 进行中 ${counts.pending} · 已关闭 ${counts.closed}`
        }
      >
        <button className="primary" onClick={() => setCreating(true)}>
          新建工单
        </button>
      </PageHead>

      <div className="card">
        <div className="row toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="搜索标题 / 内容 / 邮箱"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'open' ? '待处理' : s === 'pending' ? '进行中' : '已关闭'}
              </option>
            ))}
          </select>
          {tag && (
            <button
              onClick={() => {
                const p = new URLSearchParams(params);
                p.delete('tag');
                p.delete('page');
                setParams(p, { replace: true });
              }}
            >
              标签 {tag} ✕
            </button>
          )}
        </div>
      </div>

      {creating && (
        <NewTicketDrawer
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
          <Empty label="没有符合条件的工单" />
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>标题</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 80 }}>优先级</th>
                <th style={{ width: 180 }}>请求人</th>
                <th style={{ width: 140 }}>更新时间</th>
                {canWrite && <th style={{ width: 80 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <TicketRow
                  key={t.id}
                  row={t}
                  users={users}
                  canWrite={canWrite}
                  onChanged={load}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pages > 1 && (
        <div className="row pager">
          <button onClick={() => goPage(page - 1)} disabled={page <= 1}>
            上一页
          </button>
          <span className="muted small">
            第 {page} / {pages} 页
          </span>
          <button onClick={() => goPage(page + 1)} disabled={page >= pages}>
            下一页
          </button>
        </div>
      )}
    </>
  );
}

function TicketRow({
  row,
  users,
  canWrite,
  onChanged,
  onError,
}: {
  row: Ticket;
  users: AuthUser[];
  canWrite: boolean;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <tr>
        <td className="muted">{row.id}</td>
        <td>
          <Link to={`/tickets/${row.id}`}>{row.subject}</Link>
          {(row.tags ?? []).length > 0 && (
            <div style={{ marginTop: 3 }}>
              {(row.tags ?? []).map((name) => (
                <span className="tag" key={name}>
                  {name}
                </span>
              ))}
            </div>
          )}
        </td>
        <td>
          <StatusPill status={row.status} />
        </td>
        <td>
          <PriorityPill priority={row.priority} />
        </td>
        <td className="small">
          {row.requesterName ?? '—'}
          <div className="muted">{row.requesterEmail}</div>
        </td>
        <td className="small muted">{formatTime(row.updatedAt)}</td>
        {canWrite && (
          <td>
            <button onClick={() => setEditing(true)}>编辑</button>
          </td>
        )}
      </tr>
      {editing && (
        <EditTicketDrawer
          row={row}
          users={users}
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

/**
 * Editing a ticket from the list. The title stays a link to the detail page,
 * which is where replies live; this drawer only covers the fields the API's
 * PATCH accepts, so the two entry points do not overlap.
 */
function EditTicketDrawer({
  row,
  users,
  onClose,
  onSaved,
  onError,
}: {
  row: Ticket;
  users: AuthUser[];
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.body);
  const [status, setStatus] = useState(row.status);
  const [priority, setPriority] = useState(row.priority);
  const [assigneeId, setAssigneeId] = useState(row.assigneeId == null ? '' : String(row.assigneeId));
  const [tags, setTags] = useState((row.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onError(null);
    try {
      await api.updateTicket(row.id, {
        subject,
        body,
        status,
        priority,
        assigneeId: assigneeId ? Number(assigneeId) : null,
        tags: tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`编辑工单 · #${row.id}`}
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="edit-ticket-form" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="edit-ticket-form" onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="标题">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={{ width: '100%' }}
            maxLength={500}
            required
          />
        </Field>
        <Field label="描述">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="row">
          <div style={{ width: 150 }}>
            <Field label="状态">
              <select value={status} onChange={(e) => setStatus(e.target.value as Ticket['status'])} style={{ width: '100%' }}>
                <option value="open">待处理</option>
                <option value="pending">进行中</option>
                <option value="closed">已关闭</option>
              </select>
            </Field>
          </div>
          <div style={{ width: 130 }}>
            <Field label="优先级">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Ticket['priority'])}
                style={{ width: '100%' }}
              >
                <option value="low">低</option>
                <option value="normal">普通</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
            </Field>
          </div>
        </div>
        {users.length > 0 && (
          <Field label="负责人">
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={{ width: '100%' }}>
              <option value="">未指派</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="标签（逗号分隔）">
          <input value={tags} onChange={(e) => setTags(e.target.value)} style={{ width: '100%' }} />
        </Field>
      </form>
    </Drawer>
  );
}

function NewTicketDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [priority, setPriority] = useState('normal');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTicket({
        subject,
        body,
        requesterEmail,
        requesterName: requesterName || null,
        priority,
        tags: tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="新建工单"
      onClose={onClose}
      footer={
        <>
          <button className="primary" type="submit" form="new-ticket-form" disabled={busy}>
            {busy ? '提交中…' : '创建'}
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <form id="new-ticket-form" onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="标题">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={{ width: '100%' }}
            maxLength={500}
            autoFocus
            required
          />
        </Field>
        <Field label="描述">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="请求人邮箱">
          <input
            type="email"
            value={requesterEmail}
            onChange={(e) => setRequesterEmail(e.target.value)}
            style={{ width: '100%' }}
            required
          />
        </Field>
        <Field label="请求人姓名">
          <input
            value={requesterName}
            onChange={(e) => setRequesterName(e.target.value)}
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="优先级">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%' }}>
            <option value="low">低</option>
            <option value="normal">普通</option>
            <option value="high">高</option>
            <option value="urgent">紧急</option>
          </select>
        </Field>
        <Field label="标签（逗号分隔）">
          <input value={tags} onChange={(e) => setTags(e.target.value)} style={{ width: '100%' }} />
        </Field>
      </form>
    </Drawer>
  );
}
