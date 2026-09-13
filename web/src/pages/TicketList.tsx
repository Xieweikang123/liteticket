import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import type { Stats, Ticket } from '../api.ts';
import { ErrorBox, Empty, Field, Loading, PriorityPill, StatusPill, formatTime } from '../ui.tsx';

const STATUSES = ['open', 'pending', 'closed'];

export function TicketListPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';

  const [items, setItems] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // The search box is local state so typing does not fight the URL on every
  // keystroke; it is pushed to the URL on a debounce.
  const [draft, setDraft] = useState(q);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, stats] = await Promise.all([
        api.listTickets({ status, q, tag, limit: 50 }),
        api.stats(),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setCounts(stats);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [status, q, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (draft) next.set('q', draft);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [draft, q, params, setParams]);

  function setStatus(next: string) {
    const p = new URLSearchParams(params);
    if (next) p.set('status', next);
    else p.delete('status');
    setParams(p, { replace: true });
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <input
            type="search"
            placeholder="搜索标题 / 内容 / 邮箱"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{ minWidth: 240 }}
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
                setParams(p, { replace: true });
              }}
            >
              标签 {tag} ✕
            </button>
          )}
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            共 {total} 张
            {counts && ` · 待处理 ${counts.open} · 进行中 ${counts.pending} · 已关闭 ${counts.closed}`}
          </span>
          <button className="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? '取消' : '新建工单'}
          </button>
        </div>
      </div>

      {creating && (
        <NewTicketCard
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
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="muted">{t.id}</td>
                  <td>
                    <Link to={`/tickets/${t.id}`}>{t.subject}</Link>
                    {(t.tags ?? []).length > 0 && (
                      <div style={{ marginTop: 3 }}>
                        {(t.tags ?? []).map((name) => (
                          <span className="tag" key={name}>
                            {name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusPill status={t.status} />
                  </td>
                  <td>
                    <PriorityPill priority={t.priority} />
                  </td>
                  <td className="small">
                    {t.requesterName ?? '—'}
                    <div className="muted">{t.requesterEmail}</div>
                  </td>
                  <td className="small muted">{formatTime(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function NewTicketCard({ onCreated }: { onCreated: () => void }) {
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
    <form className="card" onSubmit={submit}>
      <h2>新建工单</h2>
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
        <div style={{ flex: 1, minWidth: 200 }}>
          <Field label="请求人邮箱">
            <input
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              style={{ width: '100%' }}
              required
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="请求人姓名">
            <input
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              style={{ width: '100%' }}
            />
          </Field>
        </div>
        <div style={{ width: 120 }}>
          <Field label="优先级">
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%' }}>
              <option value="low">低</option>
              <option value="normal">普通</option>
              <option value="high">高</option>
              <option value="urgent">紧急</option>
            </select>
          </Field>
        </div>
      </div>
      <Field label="标签（逗号分隔）">
        <input value={tags} onChange={(e) => setTags(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '提交中…' : '创建'}
      </button>
    </form>
  );
}
