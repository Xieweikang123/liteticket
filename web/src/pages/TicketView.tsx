import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import type { Attachment, AuthUser, Comment, Ticket, TicketEvent } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import {
  ConfirmButton,
  Empty,
  ErrorBox,
  Field,
  Loading,
  PriorityPill,
  StatusPill,
  formatTime,
} from '../ui.tsx';

type Full = Ticket & {
  comments: Comment[];
  attachments: Attachment[];
  events: TicketEvent[];
};

const EVENT_FIELD_LABEL: Record<string, string> = {
  status: '状态',
  priority: '优先级',
  assignee: '负责人',
  subject: '标题',
  tags: '标签',
};

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  pending: '进行中',
  closed: '已关闭',
};

const PRIORITY_LABEL: Record<string, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

function formatEventValue(field: string, value: string | null): string {
  if (value == null || value === '') return '（空）';
  if (field === 'status') return STATUS_LABEL[value] ?? value;
  if (field === 'priority') return PRIORITY_LABEL[value] ?? value;
  return value;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Everything there is to see about one ticket: facts, the handling controls,
 * attachments, the change timeline, the replies, and the reply box.
 *
 * It is one component because the list opens it in a drawer and `/tickets/:id`
 * renders it as a page — the deep link stays the canonical entry point (the API
 * and the browser probes both use it), while the drawer is the same content
 * without leaving the list. Two renderings of a ticket would drift the moment
 * a field is added to one of them.
 *
 * `embedded` is the whole difference: a page separates its sections with
 * cards, a drawer is already a surface so it uses rules instead.
 */
export function TicketView({
  id,
  embedded = false,
  onChanged,
  onDeleted,
}: {
  id: number;
  embedded?: boolean;
  /** A mutation landed; the caller's list should re-read. */
  onChanged?: () => void;
  /** The ticket is gone; the caller must leave or close. */
  onDeleted?: () => void;
}) {
  const { permissions } = useAuth();

  const [ticket, setTicket] = useState<Full | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  /**
   * `initial` marks the first load only. A refresh after a mutation must not
   * flip `loading` back on: that would unmount the whole view — including the
   * comment form the user is typing in — and remount it empty, losing whatever
   * they had entered and closing any open control.
   */
  const load = useCallback(
    async (opts: { initial?: boolean } = {}) => {
      if (opts.initial) setLoading(true);
      setError(null);
      try {
        // The assignee picker needs users, but a role may be able to work
        // tickets without being able to list users. Fetch separately so a
        // denied user list leaves the ticket — and the reply form — usable.
        const [t, u] = await Promise.all([
          api.getTicket(id),
          can(permissions, 'users.read') ? api.listUsers() : Promise.resolve({ items: [] }),
        ]);
        setTicket(t);
        setUsers(u.items);
      } catch (err) {
        setError(err);
        setTicket(null);
      } finally {
        if (opts.initial) setLoading(false);
      }
    },
    [id, permissions],
  );

  useEffect(() => {
    if (Number.isInteger(id)) void load({ initial: true });
  }, [id, load]);

  async function patch(fields: Record<string, unknown>) {
    setError(null);
    try {
      await api.updateTicket(id, fields);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    try {
      await api.deleteTicket(id);
      onDeleted?.();
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
          工单不存在。{!embedded && <Link to="/">返回列表</Link>}
        </div>
      </>
    );
  }

  const Section = ({ children }: { children: React.ReactNode }) => (
    <div className={embedded ? 'dsec' : 'card'}>{children}</div>
  );

  const canWrite = can(permissions, 'tickets.write');

  return (
    <>
      <Section>
        <div className="muted small meta-line">
          #{ticket.id} · 创建 {formatTime(ticket.createdAt)} · 更新 {formatTime(ticket.updatedAt)}
        </div>
        <h2 className="ticket-subject">{ticket.subject}</h2>
        <div className="row" style={{ marginBottom: 14, gap: 8 }}>
          <StatusPill status={ticket.status} />
          <PriorityPill priority={ticket.priority} />
          {(ticket.tags ?? []).map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        {ticket.body && (
          <pre style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{ticket.body}</pre>
        )}
        <div className="muted small" style={{ marginTop: 14 }}>
          请求人：{ticket.requesterName ?? '—'} &lt;{ticket.requesterEmail}&gt;
          {ticket.closedAt && ` · 关闭于 ${formatTime(ticket.closedAt)}`}
        </div>
      </Section>

      <ErrorBox error={error} />

      <Section>
        <h2>处理</h2>
        <div className="row">
          <div style={{ width: 150 }}>
            <Field label="状态">
              <select
                value={ticket.status}
                onChange={(e) => void patch({ status: e.target.value })}
                style={{ width: '100%' }}
                disabled={!canWrite}
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
                disabled={!canWrite}
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
                disabled={!canWrite}
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
          {can(permissions, 'tickets.delete') && (
            <span style={{ marginTop: 18 }}>
              <ConfirmButton label="删除工单" question="不可恢复" onConfirm={remove} />
            </span>
          )}
        </div>
      </Section>

      <Section>
        <h2>附件（{ticket.attachments.length}）</h2>
        <AttachmentList
          ticketId={id}
          items={ticket.attachments}
          canWrite={canWrite}
          onChanged={() => {
            void load();
            onChanged?.();
          }}
          onError={setError}
        />
      </Section>

      <Section>
        <h2>变更记录（{ticket.events.length}）</h2>
        {ticket.events.length === 0 ? (
          <Empty label="还没有字段变更" />
        ) : (
          <ul className="timeline">
            {ticket.events.map((e) => (
              <li key={e.id} className="timeline-item">
                <div className="timeline-main">
                  <span className="timeline-field">
                    {EVENT_FIELD_LABEL[e.field] ?? e.field}
                  </span>
                  <span className="muted">
                    {formatEventValue(e.field, e.fromValue)}
                    {' → '}
                    {formatEventValue(e.field, e.toValue)}
                  </span>
                </div>
                <div className="small muted">
                  {e.actorName ?? '未知'} · {formatTime(e.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section>
        <h2>回复与内部备注（{ticket.comments.length}）</h2>
        {ticket.comments.length === 0 ? (
          <Empty label="还没有回复" />
        ) : (
          ticket.comments.map((c) => (
            <div key={c.id} className={`comment${c.isInternal ? ' internal' : ''}`}>
              <div className="small muted" style={{ marginBottom: 4 }}>
                {c.authorEmail ?? (c.authorId ? `用户 #${c.authorId}` : '匿名')} ·{' '}
                {formatTime(c.createdAt)}
                {c.isInternal && (
                  <span className="pill internal" style={{ marginLeft: 8 }}>
                    内部备注
                  </span>
                )}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))
        )}
        {canWrite && (
          <CommentForm
            ticketId={id}
            onAdded={() => {
              void load();
              onChanged?.();
            }}
          />
        )}
      </Section>
    </>
  );
}

function AttachmentList({
  ticketId,
  items,
  canWrite,
  onChanged,
  onError,
}: {
  ticketId: number;
  items: Attachment[];
  canWrite: boolean;
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    onError(null);
    try {
      for (const file of Array.from(files)) {
        await api.uploadAttachment(ticketId, file);
      }
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function download(a: Attachment) {
    onError(null);
    try {
      await api.downloadAttachment(ticketId, a);
    } catch (err) {
      onError(err);
    }
  }

  async function remove(a: Attachment) {
    onError(null);
    try {
      await api.deleteAttachment(ticketId, a.id);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      {items.length === 0 ? (
        <Empty label="还没有附件" />
      ) : (
        <ul className="attach-list">
          {items.map((a) => (
            <li key={a.id} className="attach-row">
              <button type="button" className="linkish" onClick={() => void download(a)}>
                {a.filename}
              </button>
              <span className="muted small">{formatBytes(a.size)}</span>
              <span className="muted small">{formatTime(a.createdAt)}</span>
              {canWrite && (
                <ConfirmButton label="删除" question="删除此附件？" onConfirm={() => remove(a)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className="row" style={{ marginTop: 10 }}>
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => void onPick(e.target.files)}
          />
          {busy && <span className="muted small">上传中…</span>}
        </div>
      )}
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
