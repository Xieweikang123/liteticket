import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import type { AuthUser, Stats, Ticket } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import { TicketView } from './TicketView.tsx';
import {
  Drawer,
  ErrorBox,
  Empty,
  Field,
  Loading,
  PageHead,
  PriorityPill,
  StatusCounts,
  StatusPill,
  formatTime,
} from '../ui.tsx';

const PAGE_SIZES = [10, 20, 50];
const PAGE_SIZE = 50;

type Sort = 'updated' | 'priority' | 'id';

const SORTS: Sort[] = ['updated', 'priority', 'id'];

function parseSort(value: string | null): Sort {
  return SORTS.includes(value as Sort) ? (value as Sort) : 'updated';
}

export function TicketListPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const size = PAGE_SIZES.includes(Number(params.get('size')))
    ? Number(params.get('size'))
    : PAGE_SIZE;
  const sort = parseSort(params.get('sort'));
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';

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
        api.listTickets({ status, q, tag, sort, order, limit: size, offset: (page - 1) * size }),
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
  }, [status, q, tag, sort, order, page, size, permissions]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / size));

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

  // Changing the page size changes where every page boundary falls, so the
  // current page number is meaningless afterwards — go back to the first.
  function setSize(next: number) {
    const p = new URLSearchParams(params);
    if (next === PAGE_SIZE) p.delete('size');
    else p.set('size', String(next));
    p.delete('page');
    setParams(p, { replace: true });
  }

  // Clicking a header sorts by it; clicking the active one flips direction. The
  // default column keeps its direction out of the URL, so a bare `/` and an
  // explicit "updated desc" share one state.
  function toggleSort(next: Sort) {
    const p = new URLSearchParams(params);
    const nextOrder = sort === next ? (order === 'desc' ? 'asc' : 'desc') : 'desc';
    if (next === 'updated' && nextOrder === 'desc') p.delete('sort');
    else p.set('sort', next);
    if (nextOrder === 'desc') p.delete('order');
    else p.set('order', nextOrder);
    p.delete('page');
    setParams(p, { replace: true });
  }

  const sortHeader = (key: Sort, label: string, opts: { right?: boolean; center?: boolean } = {}) => {
    const active = sort === key;
    return (
      <th
        key={key}
        className={`sortable${opts.right ? ' right' : ''}${opts.center ? ' col-center' : ''}`}
        aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className={`sort-th${active ? ' active' : ''}`} onClick={() => toggleSort(key)}>
          {label}
          <span className="sort-arrow" aria-hidden="true">
            {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <>
      <PageHead
        title="工单"
        sub={
          counts && <StatusCounts counts={counts} active={status} onSelect={setStatus} />
        }
      >
        <button className="primary" onClick={() => setCreating(true)}>
          新建工单
        </button>
      </PageHead>

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
        <div className="card-toolbar">
          <div className="search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="m20.5 20.5-4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              className="search-input"
              type="search"
              placeholder="搜索标题 / 内容 / 邮箱"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft && (
              <button
                type="button"
                className="search-clear"
                aria-label="清空搜索"
                onClick={() => setDraft('')}
              >
                ✕
              </button>
            )}
          </div>
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
          {(q || status || tag) && (
            <button
              className="link"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              重置筛选
            </button>
          )}
        </div>

        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty label="没有符合条件的工单" />
        ) : (
          <div className="card-scroll">
            <table>
              <thead>
                <tr>
                  {sortHeader('id', '#', { center: true })}
                  <th>标题</th>
                  <th className="col-center" style={{ width: 90 }}>状态</th>
                  {sortHeader('priority', '优先级', { center: true })}
                  <th style={{ width: 180 }}>请求人</th>
                  {sortHeader('updated', '更新时间', { right: true })}
                  {canWrite && <th className="col-center" style={{ width: 116 }}>操作</th>}
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
          </div>
        )}
      </div>

      {!loading && items.length > 0 && (
        <div className="pager">
          <span className="muted small">
            共 {total} 条
            {total > 0 && (
              <>
                ，第 {(page - 1) * size + 1}–{Math.min(page * size, total)} 条
              </>
            )}
          </span>
          <label className="pager-size">
            每页
            <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            条
          </label>
          {pages > 1 && (
            <div className="pager-nav">
              <button onClick={() => goPage(page - 1)} disabled={page <= 1}>
                上一页
              </button>
              <span className="muted small">
                {page} / {pages}
              </span>
              <button onClick={() => goPage(page + 1)} disabled={page >= pages}>
                下一页
              </button>
            </div>
          )}
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
  const [viewing, setViewing] = useState(false);

  return (
    <>
      <tr>
        <td className="muted small col-center num-cell">{row.id}</td>
        <td>
          {/* The subject stays a plain link to the canonical detail page — a
              deep link, a bookmark, and the browser probes all depend on that
              route rendering. 查看 in the actions column opens the same view as
              a sheet, which is the way to look at a ticket without losing the
              filters, sort, and scroll position. */}
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
        <td className="col-center">
          <StatusPill status={row.status} />
        </td>
        <td className="col-center">
          <PriorityPill priority={row.priority} />
        </td>
        <td className="small">
          {/* One line per requester: the name only takes a second line when it
              exists, so the common anonymous row is not stretched by a dash. */}
          <div className="req">
            <span className="req-email">{row.requesterEmail}</span>
            {row.requesterName && <span className="req-name muted">{row.requesterName}</span>}
          </div>
        </td>
        <td className="small muted time-cell">{formatTime(row.updatedAt)}</td>
        {canWrite && (
          <td className="col-center">
            <div className="row-actions">
              <button className="ghost sm" onClick={() => setViewing(true)}>
                查看
              </button>
              <button className="ghost sm" onClick={() => setEditing(true)}>
                编辑
              </button>
            </div>
          </td>
        )}
      </tr>
      {viewing && (
        <ViewTicketDrawer id={row.id} onClose={() => setViewing(false)} onChanged={onChanged} />
      )}
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
 * The detail view as a sheet over the list, so checking a ticket and going back
 * to the next one does not cost a page load — the filters, the sort, and the
 * scroll position all survive. It owns the full view, including replies, so the
 * only thing left to the detail page is being linkable.
 */
function ViewTicketDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Drawer title={`工单 · #${id}`} onClose={onClose} wide>
      <TicketView id={id} embedded onChanged={onChanged} onDeleted={onClose} />
    </Drawer>
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
