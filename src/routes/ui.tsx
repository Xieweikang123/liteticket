import { Hono } from 'hono';
import type { Db } from '../db/index.ts';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../db/schema.ts';
import * as svc from '../services/tickets.ts';
import { Layout, PriorityPill, StatusPill, STATUS_LABEL } from '../views/layout.tsx';
import { EmptyRow, TicketRow } from '../views/ticket-row.tsx';

function parseTags(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * UI routes. Pages return full HTML documents; mutation endpoints return HTML
 * fragments for htmx to swap in. There is no JSON here — that is the /api
 * surface's job.
 */
export function uiRoutes(db: Db) {
  const ui = new Hono();

  // ---- Pages -------------------------------------------------------------

  ui.get('/', async (c) => {
    const status = c.req.query('status');
    const q = c.req.query('q');
    const tag = c.req.query('tag');

    const { items, total } = await svc.listTickets(db, {
      status: TICKET_STATUSES.includes(status as never)
        ? (status as 'open' | 'pending' | 'closed')
        : undefined,
      q: q || undefined,
      tag: tag || undefined,
    });
    const counts = await svc.stats(db);

    return c.html(
      <Layout title="工单" active="/">
        <div class="card">
          <form class="row" hx-get="/ui/tickets" hx-target="#ticket-list" hx-swap="outerHTML">
            <input
              type="search"
              name="q"
              placeholder="搜索标题 / 内容 / 邮箱"
              value={q ?? ''}
              hx-get="/ui/tickets"
              hx-trigger="keyup changed delay:350ms"
              hx-target="#ticket-list"
              hx-include="closest form"
            />
            <select name="status" hx-get="/ui/tickets" hx-target="#ticket-list" hx-include="closest form">
              <option value="">全部状态</option>
              {TICKET_STATUSES.map((s) => (
                <option value={s} selected={status === s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <input type="hidden" name="tag" value={tag ?? ''} />
            <button class="primary" type="submit">
              筛选
            </button>
            <span class="muted">
              共 {total} 张 · 待处理 {counts.open} · 进行中 {counts.pending} · 已关闭{' '}
              {counts.closed}
            </span>
          </form>
        </div>

        <TicketTable items={items} />
      </Layout>,
    );
  });

  ui.get('/new', async (c) => {
    const people = await svc.listUsers(db);

    return c.html(
      <Layout title="新建工单" active="/new">
        <div class="card">
          <h2 style="margin-top:0">新建工单</h2>
          <form method="post" action="/ui/tickets">
            <div class="field">
              <label for="subject">标题 *</label>
              <input id="subject" name="subject" required maxlength={500} style="width:100%" />
            </div>
            <div class="field">
              <label for="body">描述</label>
              <textarea id="body" name="body" placeholder="详细描述问题…" />
            </div>
            <div class="grid">
              <div class="field">
                <label for="requesterEmail">请求人邮箱 *</label>
                <input id="requesterEmail" name="requesterEmail" type="email" required style="width:100%" />
              </div>
              <div class="field">
                <label for="requesterName">请求人姓名</label>
                <input id="requesterName" name="requesterName" style="width:100%" />
              </div>
              <div class="field">
                <label for="priority">优先级</label>
                <select id="priority" name="priority" style="width:100%">
                  {TICKET_PRIORITIES.map((p) => (
                    <option value={p} selected={p === 'normal'}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label for="assigneeId">指派给</label>
                <select id="assigneeId" name="assigneeId" style="width:100%">
                  <option value="">未指派</option>
                  {people.map((u) => (
                    <option value={String(u.id)}>{u.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div class="field">
              <label for="tags">标签（逗号分隔）</label>
              <input id="tags" name="tags" placeholder="bug, 硬件" style="width:100%" />
            </div>
            <div class="row">
              <button class="primary" type="submit">
                创建
              </button>
              <a href="/">取消</a>
            </div>
          </form>
        </div>
      </Layout>,
    );
  });

  ui.get('/users', async (c) => {
    const people = await svc.listUsers(db);

    return c.html(
      <Layout title="用户" active="/users">
        <div class="card">
          <h2 style="margin-top:0">新建用户</h2>
          <form method="post" action="/ui/users" class="row">
            <input name="name" placeholder="姓名 *" required maxlength={200} />
            <input name="email" type="email" placeholder="邮箱 *" required style="min-width:240px" />
            <button class="primary" type="submit">
              添加
            </button>
          </form>
        </div>

        <div class="card">
          <h3 style="margin-top:0">用户 ({people.length})</h3>
          {people.length === 0 && <p class="muted">还没有用户。</p>}
          {people.map((u) => (
            <form method="post" action={`/ui/users/${u.id}/update`} class="row" style="padding:8px 0">
              <input name="name" value={u.name} required maxlength={200} style="min-width:160px" />
              <input
                name="email"
                type="email"
                value={u.email}
                required
                style="min-width:240px"
              />
              <span class="muted">{u.createdAt}</span>
              <span class="spacer" style="flex:1" />
              <button type="submit">保存</button>
              <button
                class="danger"
                type="submit"
                formaction={`/ui/users/${u.id}/delete`}
                formmethod="post"
                onclick="return confirm('确定删除该用户？其名下工单将变为未指派。')"
              >
                删除
              </button>
            </form>
          ))}
        </div>
      </Layout>,
    );
  });

  ui.get('/api-docs', (c) =>
    c.html(
      <Layout title="API" active="/api-docs">
        <div class="card">
          <h2 style="margin-top:0">REST API</h2>
          <p class="muted">
            每个 UI 动作都有对应的 API。鉴权：<code>Authorization: Bearer &lt;token&gt;</code>
          </p>
          <table>
            <thead>
              <tr>
                <th>方法</th>
                <th>路径</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['GET', '/api/health', '健康检查'],
                ['GET', '/api/tickets', '工单列表（支持 status/assigneeId/tag/q/limit/offset）'],
                ['GET', '/api/tickets/:id', '工单详情（?includeInternal=true 含内部备注）'],
                ['POST', '/api/tickets', '创建工单'],
                ['PATCH', '/api/tickets/:id', '更新工单（状态/优先级/指派/标签）'],
                ['DELETE', '/api/tickets/:id', '删除工单'],
                ['GET', '/api/tickets/:id/comments', '评论列表'],
                ['POST', '/api/tickets/:id/comments', '添加评论（isInternal=true 为内部备注）'],
                ['GET', '/api/users', '用户列表'],
                ['GET', '/api/users/:id', '用户详情'],
                ['POST', '/api/users', '创建用户'],
                ['PATCH', '/api/users/:id', '更新用户'],
                ['DELETE', '/api/users/:id', '删除用户（工单转为未指派）'],
                ['GET', '/api/tags', '标签列表'],
                ['GET', '/api/stats', '状态计数'],
              ].map(([m, p, d]) => (
                <tr>
                  <td>
                    <strong>{m}</strong>
                  </td>
                  <td>
                    <code>{p}</code>
                  </td>
                  <td class="muted">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Layout>,
    ),
  );

  ui.get('/tickets/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    const ticket = await svc.getTicket(db, id);
    if (!ticket) return c.notFound();

    const comments = await svc.listComments(db, id, { includeInternal: true });
    const people = await svc.listUsers(db);

    return c.html(
      <Layout title={ticket.subject}>
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h2 style="margin:0">{ticket.subject}</h2>
            <a href="/">← 返回列表</a>
          </div>
          <div class="row" style="margin-top:10px">
            <StatusPill status={ticket.status} />
            <PriorityPill priority={ticket.priority} />
            {ticket.tags.map((t) => (
              <span class="tag">{t}</span>
            ))}
          </div>
          <p class="muted" style="margin-bottom:0">
            {ticket.requesterName ? `${ticket.requesterName} · ` : ''}
            {ticket.requesterEmail} · 创建于 {ticket.createdAt}
            {ticket.assigneeName ? ` · 指派给 ${ticket.assigneeName}` : ''}
          </p>
        </div>

        <div class="card">
          <h3 style="margin-top:0">更新</h3>
          <form method="post" action={`/ui/tickets/${ticket.id}/update`} class="row">
            <select name="status">
              {TICKET_STATUSES.map((s) => (
                <option value={s} selected={ticket.status === s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select name="priority">
              {TICKET_PRIORITIES.map((p) => (
                <option value={p} selected={ticket.priority === p}>
                  {p}
                </option>
              ))}
            </select>
            <select name="assigneeId">
              <option value="">未指派</option>
              {people.map((u) => (
                <option value={String(u.id)} selected={ticket.assigneeId === u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <input name="tags" value={ticket.tags.join(', ')} placeholder="标签" />
            <button class="primary" type="submit">
              保存
            </button>
          </form>
        </div>

        {ticket.body && (
          <div class="card">
            <h3 style="margin-top:0">描述</h3>
            <div style="white-space:pre-wrap">{ticket.body}</div>
          </div>
        )}

        <div class="card">
          <h3 style="margin-top:0">评论 ({comments.length})</h3>
          {comments.length === 0 && <p class="muted">还没有评论。</p>}
          {comments.map((cm) => (
            <div class={`comment${cm.isInternal ? ' internal' : ''}`}>
              <div class="meta">
                {cm.isInternal ? '🔒 内部备注' : '公开回复'} ·{' '}
                {cm.authorEmail ?? '系统'} · {cm.createdAt}
              </div>
              <div class="body">{cm.body}</div>
            </div>
          ))}

          <form method="post" action={`/ui/tickets/${ticket.id}/comments`} style="margin-top:16px">
            <div class="field">
              <label for="cbody">添加评论</label>
              <textarea id="cbody" name="body" required />
            </div>
            <div class="row">
              <select name="isInternal">
                <option value="false">公开回复</option>
                <option value="true">内部备注</option>
              </select>
              <button class="primary" type="submit">
                提交
              </button>
            </div>
          </form>
        </div>
      </Layout>,
    );
  });

  // ---- htmx fragments ----------------------------------------------------

  // The list fragment. Returned by the search/filter form, and also by any
  // row mutation that could remove a row from a filtered view.
  ui.get('/ui/tickets', async (c) => {
    const status = c.req.query('status');
    const q = c.req.query('q');
    const tag = c.req.query('tag');

    const { items } = await svc.listTickets(db, {
      status: TICKET_STATUSES.includes(status as never)
        ? (status as 'open' | 'pending' | 'closed')
        : undefined,
      q: q || undefined,
      tag: tag || undefined,
    });

    return c.html(<TicketTable items={items} />);
  });

  ui.patch('/ui/tickets/:id/status', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    const body = await c.req.parseBody().catch(() => null);
    const raw = (body?.status as string) ?? c.req.header('HX-Prompt') ?? '';
    const status = TICKET_STATUSES.includes(raw as never)
      ? (raw as 'open' | 'pending' | 'closed')
      : null;

    if (!status) return c.text('invalid status', 400);

    const updated = await svc.updateTicket(db, id, { status });
    if (!updated) return c.notFound();

    // htmx sends hx-vals as form-encoded for PATCH; fall back to query too.
    return c.html(<TicketRow ticket={updated} />);
  });

  ui.delete('/ui/tickets/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    await svc.deleteTicket(db, id);
    return c.html(<EmptyRow />);
  });

  // ---- Plain form posts (full-page redirects) ----------------------------

  ui.post('/ui/tickets', async (c) => {
    const body = await c.req.parseBody();
    const subject = String(body.subject ?? '').trim();
    const requesterEmail = String(body.requesterEmail ?? '').trim();

    if (!subject || !requesterEmail) {
      return c.text('subject and requesterEmail are required', 400);
    }

    const assigneeRaw = String(body.assigneeId ?? '').trim();
    const priorityRaw = String(body.priority ?? 'normal');

    const ticket = await svc.createTicket(db, {
      subject,
      body: String(body.body ?? ''),
      requesterEmail,
      requesterName: String(body.requesterName ?? '').trim() || null,
      priority: TICKET_PRIORITIES.includes(priorityRaw as never)
        ? (priorityRaw as 'low' | 'normal' | 'high' | 'urgent')
        : 'normal',
      assigneeId: assigneeRaw ? Number(assigneeRaw) : null,
      tags: parseTags(String(body.tags ?? '')),
    });

    return c.redirect(`/tickets/${ticket.id}`, 303);
  });

  ui.post('/ui/tickets/:id/update', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    const body = await c.req.parseBody();
    const assigneeRaw = String(body.assigneeId ?? '').trim();
    const statusRaw = String(body.status ?? '');
    const priorityRaw = String(body.priority ?? '');

    await svc.updateTicket(db, id, {
      status: TICKET_STATUSES.includes(statusRaw as never)
        ? (statusRaw as 'open' | 'pending' | 'closed')
        : undefined,
      priority: TICKET_PRIORITIES.includes(priorityRaw as never)
        ? (priorityRaw as 'low' | 'normal' | 'high' | 'urgent')
        : undefined,
      assigneeId: assigneeRaw ? Number(assigneeRaw) : null,
      tags: parseTags(String(body.tags ?? '')),
    });

    return c.redirect(`/tickets/${id}`, 303);
  });

  ui.post('/ui/tickets/:id/comments', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    const body = await c.req.parseBody();
    const text = String(body.body ?? '').trim();
    if (!text) return c.text('body is required', 400);

    await svc.addComment(db, id, {
      body: text,
      isInternal: String(body.isInternal ?? 'false') === 'true',
    });

    return c.redirect(`/tickets/${id}`, 303);
  });

  ui.post('/ui/users', async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();

    if (!name || !email) return c.text('name and email are required', 400);

    if (await svc.getUserByEmail(db, email)) {
      return c.text('email already in use', 409);
    }

    await svc.createUser(db, { name, email });
    return c.redirect('/users', 303);
  });

  ui.post('/ui/users/:id/update', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    const body = await c.req.parseBody();
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();

    if (!name || !email) return c.text('name and email are required', 400);

    const clash = await svc.getUserByEmail(db, email);
    if (clash && clash.id !== id) return c.text('email already in use', 409);

    const updated = await svc.updateUser(db, id, { name, email });
    if (!updated) return c.notFound();

    return c.redirect('/users', 303);
  });

  ui.post('/ui/users/:id/delete', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();

    await svc.deleteUser(db, id);
    return c.redirect('/users', 303);
  });

  return ui;
}

/** The table (and its wrapper) is a single swap target for htmx. */
function TicketTable({ items }: { items: svc.TicketWithMeta[] }) {
  return (
    <div id="ticket-list">
      {items.length === 0 ? (
        <div class="card empty">
          没有符合条件的工单。<a href="/new">新建一张</a>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>状态</th>
              <th>优先级</th>
              <th>指派</th>
              <th>请求人</th>
              <th>评论</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <TicketRow ticket={t} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
