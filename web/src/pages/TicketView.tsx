import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import type { Attachment, AuthUser, Comment, MentionRef, Ticket, TicketEvent } from '../api.ts';
import { useAuth, can } from '../auth.tsx';
import {
  AttachmentPreview,
  ConfirmButton,
  Empty,
  ErrorBox,
  Field,
  Lightbox,
  Loading,
  PriorityPill,
  StatusPill,
  extractFilesFromEvent,
  formatBytes,
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

/**
 * Highlight resolved @username tokens. Unknown `@…` strings stay plain text so
 * a typo does not look like a real mention.
 */
function CommentBody({ body, mentions = [] }: { body: string; mentions?: MentionRef[] }) {
  const known = new Map(mentions.map((m) => [m.username.toLowerCase(), m]));
  const nodes: React.ReactNode[] = [];
  let last = 0;
  const re = /(?:^|[^a-zA-Z0-9._-])(@[a-zA-Z0-9._-]+)/g;
  for (const m of body.matchAll(re)) {
    const full = m[0]!;
    const handle = m[1]!;
    const atIdx = m.index! + full.length - handle.length;
    if (last < atIdx) nodes.push(body.slice(last, atIdx));
    const ref = known.get(handle.slice(1).toLowerCase());
    if (ref) {
      nodes.push(
        <span key={atIdx} className="mention" title={ref.name}>
          @{ref.username}
        </span>,
      );
    } else {
      nodes.push(handle);
    }
    last = atIdx + handle.length;
  }
  if (last < body.length) nodes.push(body.slice(last));
  return <>{nodes}</>;
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
  const { permissions, user } = useAuth();

  const [ticket, setTicket] = useState<Full | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const markedReadFor = useRef<number | null>(null);

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
          api.getTicket(id, can(permissions, 'tickets.write')),
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
    markedReadFor.current = null;
    if (Number.isInteger(id)) void load({ initial: true });
  }, [id, load]);

  // Opening the ticket clears the list badge. Kept out of `load` so a parent
  // `onChanged` identity change cannot re-trigger the fetch loop.
  useEffect(() => {
    if (!user || !ticket?.mentionUnread) return;
    if (markedReadFor.current === ticket.id) return;
    markedReadFor.current = ticket.id;
    void api
      .markMentionsRead(ticket.id)
      .then(() => {
        setTicket((t) => (t && t.id === ticket.id ? { ...t, mentionUnread: false } : t));
        onChangedRef.current?.();
      })
      .catch(() => {
        /* badge clear is best-effort */
      });
  }, [user, ticket?.id, ticket?.mentionUnread]);

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
          {ticket.mentionedMe && (
            <span className={`pill mention${ticket.mentionUnread ? ' unread' : ''}`} style={{ marginLeft: 8 }}>
              {ticket.mentionUnread ? '有人提到你' : '曾提到你'}
            </span>
          )}
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
              <div style={{ whiteSpace: 'pre-wrap' }}>
                <CommentBody body={c.body} mentions={c.mentions} />
              </div>
            </div>
          ))
        )}
        {canWrite && (
          <CommentForm
            ticketId={id}
            users={users}
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
  const [isDragging, setIsDragging] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; filename: string } | null>(null);

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    onError(null);
    try {
      for (const file of files) {
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

  function onPick(files: FileList | null) {
    if (files) void uploadFiles(Array.from(files));
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
        <div className="attach-grid">
          {items.map((a) => (
            <div key={a.id} className="attach-card">
              <div className="attach-card-thumb">
                <AttachmentPreview
                  ticketId={ticketId}
                  attachment={a}
                  onOpenLightbox={(src, filename) => setLightbox({ src, filename })}
                />
              </div>
              <div className="attach-card-body">
                <div className="attach-card-name" title={a.filename}>
                  {a.filename}
                </div>
                <div className="attach-card-meta">
                  <span>{formatBytes(a.size)}</span>
                  <span>{formatTime(a.createdAt)}</span>
                </div>
                <div className="attach-card-actions">
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => void download(a)}
                  >
                    下载
                  </button>
                  {canWrite && (
                    <ConfirmButton
                      label="删除"
                      question="删除此附件？"
                      onConfirm={() => remove(a)}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <div
          className={`attach-dropzone${isDragging ? ' active' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const files = extractFilesFromEvent(e);
            if (files.length > 0) void uploadFiles(files);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => onPick(e.target.files)}
          />
          <div className="attach-dropzone-inner">
            {busy ? (
              <span className="muted small">
                <span className="spinner" /> 正在上传附件…
              </span>
            ) : (
              <>
                <span>
                  <strong>点击上传</strong> 或将文件拖拽至此处
                </span>
                <span className="small muted">支持图片、文档等（单个最大 10 MB）</span>
              </>
            )}
          </div>
        </div>
      )}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          filename={lightbox.filename}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

function CommentForm({
  ticketId,
  users,
  onAdded,
}: {
  ticketId: number;
  users: AuthUser[];
  onAdded: () => void;
}) {
  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{
    query: string;
    start: number;
    end: number;
  } | null>(null);
  const [pickIndex, setPickIndex] = useState(0);

  const suggestions =
    mention && users.length > 0
      ? users
          .filter((u) => {
            const q = mention.query.toLowerCase();
            return (
              u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)
            );
          })
          .slice(0, 8)
      : [];

  async function handleUploadFiles(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const a = await api.uploadAttachment(ticketId, file);
        const insertText = `[附件: ${a.filename}] `;
        const el = textareaRef.current;
        if (el) {
          const start = el.selectionStart ?? body.length;
          const end = el.selectionEnd ?? body.length;
          setBody((prev) => prev.slice(0, start) + insertText + prev.slice(end));
        } else {
          setBody((prev) => (prev ? `${prev} ${insertText}` : insertText));
        }
      }
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = extractFilesFromEvent(e);
    if (files.length > 0) {
      e.preventDefault();
      void handleUploadFiles(files);
    }
  }

  function syncMention(value: string, caret: number) {
    // Find an open `@token` immediately before the caret — no spaces inside.
    const before = value.slice(0, caret);
    const m = before.match(/(^|[^a-zA-Z0-9._-])@([a-zA-Z0-9._-]*)$/);
    if (!m || users.length === 0) {
      setMention(null);
      return;
    }
    const atStart = before.length - m[2]!.length - 1;
    setMention({ query: m[2]!, start: atStart, end: caret });
    setPickIndex(0);
  }

  function insertMention(user: AuthUser) {
    if (!mention) return;
    const before = body.slice(0, mention.start);
    const after = body.slice(mention.end);
    const inserted = `@${user.username} `;
    const next = before + inserted + after;
    setBody(next);
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addComment(ticketId, { body, isInternal });
      setBody('');
      setIsInternal(false);
      setMention(null);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }} className="comment-form">
      <ErrorBox error={error} />
      <div
        className="mention-wrap dropzone-wrap"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const files = extractFilesFromEvent(e);
          if (files.length > 0) void handleUploadFiles(files);
        }}
      >
        {isDragging && (
          <div className="dropzone-overlay">
            <span>📥 松开鼠标上传为附件</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={body}
          onPaste={onPaste}
          onChange={(e) => {
            const value = e.target.value;
            setBody(value);
            syncMention(value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (!mention || suggestions.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setPickIndex((i) => (i + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setPickIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              insertMention(suggestions[pickIndex]!);
            } else if (e.key === 'Escape') {
              setMention(null);
            }
          }}
          onClick={(e) => syncMention(body, e.currentTarget.selectionStart)}
          onKeyUp={(e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            syncMention(body, e.currentTarget.selectionStart);
          }}
          placeholder={users.length > 0 ? '写下回复… 输入 @ 可提及用户' : '写下回复…'}
          required
        />
        {mention && suggestions.length > 0 && (
          <ul className="mention-menu" role="listbox">
            {suggestions.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={i === pickIndex ? 'active' : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                >
                  <strong>@{u.username}</strong>
                  <span className="muted">{u.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="dropzone-hint">
        {uploading ? (
          <span style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="spinner" /> 正在上传附件…
          </span>
        ) : (
          <span>提示：支持截图后直接 <code>Ctrl+V</code> 粘贴上传，或拖拽文件至输入框</span>
        )}
      </div>
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
        <button className="primary" type="submit" disabled={busy || uploading || !body.trim()}>
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </form>
  );
}
