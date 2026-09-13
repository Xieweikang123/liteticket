import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import type { AuthUser, Comment, Ticket } from '../api.ts';
import { useAuth, isAdmin } from '../auth.tsx';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  PriorityPill,
  StatusPill,
  formatTime,
} from '../ui.tsx';

type Full = Ticket & { comments: Comment[] };

export function TicketDetailPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const navigate = useNavigate();
  const { user } = useAuth();

  const [ticket, setTicket] = useState<Full | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  /**
   * `initial` marks the first load only. A refresh after a mutation must not
   * flip `loading` back on: that would unmount the whole page — including the
   * comment form the user is typing in — and remount it empty, losing whatever
   * they had entered and closing any open control.
   */
  const load = useCallback(
    async (opts: { initial?: boolean } = {}) => {
      if (opts.initial) setLoading(true);
      setError(null);
      try {
        const [t, u] = await Promise.all([api.getTicket(id), api.listUsers()]);
        setTicket(t);
        setUsers(u.items);
      } catch (err) {
        setError(err);
        setTicket(null);
      } finally {
        if (opts.initial) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    if (Number.isInteger(id)) void load({ initial: true });
  }, [id, load]);

  async function patch(fields: Record<string, unknown>) {
    setError(null);
    try {
      await api.updateTicket(id, fields);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    if (!confirm(`确定删除工单 #${id}？此操作不可恢复。`)) return;
    try {
      await api.deleteTicket(id);
      navigate('/');
    } catch (err) {
      setError(err);
    }
  }

  if (!Number.isInteger(id)) return <div className="center">无效的工单号</div>;
  if (loading) return <Loading />;
  if (!ticket) {
    return (
      <>
        <ErrorBox error={error} />
        <div className="center">
          工单不存在。<Link to="/">返回列表</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <Link to="/" className="small">
            ← 返回列表
          </Link>
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            #{ticket.id} · 创建 {formatTime(ticket.createdAt)} · 更新{' '}
            {formatTime(ticket.updatedAt)}
          </span>
        </div>
        <h2 style={{ marginTop: 0 }}>{ticket.subject}</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <StatusPill status={ticket.status} />
          <PriorityPill priority={ticket.priority} />
          {(ticket.tags ?? []).map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        {ticket.body && <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{ticket.body}</pre>}
        <div className="muted small" style={{ marginTop: 12 }}>
          请求人：{ticket.requesterName ?? '—'} &lt;{ticket.requesterEmail}&gt;
          {ticket.closedAt && ` · 关闭于 ${formatTime(ticket.closedAt)}`}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="card">
        <h2>处理</h2>
        <div className="row">
          <div style={{ width: 150 }}>
            <Field label="状态">
              <select
                value={ticket.status}
                onChange={(e) => void patch({ status: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="open">待处理</option>
                <option value="pending">进行中</option>
                <option value="closed">已关闭</option>
              </select>
            </Field>
          </div>
          <div style={{ width: 130 }}>
            <Field label="优先级">
              <select
                value={ticket.priority}
                onChange={(e) => void patch({ priority: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="low">低</option>
                <option value="normal">普通</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
            </Field>
          </div>
          <div style={{ width: 220 }}>
            <Field label="负责人">
              <select
                value={ticket.assigneeId ?? ''}
                onChange={(e) =>
                  void patch({ assigneeId: e.target.value ? Number(e.target.value) : null })
                }
                style={{ width: '100%' }}
              >
                <option value="">未指派</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {isAdmin(user?.role) && (
            <button className="danger" onClick={remove} style={{ marginTop: 18 }}>
              删除工单
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>回复与内部备注（{ticket.comments.length}）</h2>
        {ticket.comments.length === 0 ? (
          <Empty label="还没有回复" />
        ) : (
          ticket.comments.map((c) => (
            <div key={c.id} className={`comment${c.isInternal ? ' internal' : ''}`}>
              <div className="small muted" style={{ marginBottom: 4 }}>
                {c.authorEmail ?? (c.authorId ? `用户 #${c.authorId}` : '匿名')} ·{' '}
                {formatTime(c.createdAt)}
                {c.isInternal && <span className="pill internal" style={{ marginLeft: 8 }}>内部备注</span>}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))
        )}
        <CommentForm ticketId={id} onAdded={load} />
      </div>
    </>
  );
}

function CommentForm({ ticketId, onAdded }: { ticketId: number; onAdded: () => void }) {
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addComment(ticketId, { body, isInternal });
      setBody('');
      setIsInternal(false);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <ErrorBox error={error} />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="写下回复…"
        required
      />
      <div className="row" style={{ marginTop: 8 }}>
        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={isInternal}
            onChange={(e) => setIsInternal(e.target.checked)}
            style={{ width: 'auto' }}
          />
          内部备注（请求人不可见）
        </label>
        <button className="primary" type="submit" disabled={busy || !body.trim()}>
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </form>
  );
}
