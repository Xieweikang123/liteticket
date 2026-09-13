/**
 * End-to-end verification for liteticket.
 *
 * Run against a live server:
 *   node scripts/verify.mjs <token> [baseUrl]
 *
 * Uses fetch with explicit UTF-8 so results are not affected by the terminal's
 * console encoding.
 */
const token = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:8787';

if (!token) {
  console.error('usage: node scripts/verify.mjs <token> [baseUrl]');
  process.exit(1);
}

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const auth = { Authorization: `Bearer ${token}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json; charset=utf-8' };

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

console.log(`\nverifying ${base}\n`);

// ---- health & auth -------------------------------------------------------
{
  const r = await api('/api/health');
  check('health is public', r.status === 200 && r.body?.ok === true, `status ${r.status}`);
}
{
  const r = await api('/api/tickets');
  check('missing token rejected with 401', r.status === 401, `status ${r.status}`);
}
{
  const r = await api('/api/tickets', { headers: { Authorization: 'Bearer wrong-token' } });
  check('bad token rejected with 401', r.status === 401, `status ${r.status}`);
}
{
  const r = await api('/api/tickets', { headers: auth });
  check('good token accepted', r.status === 200, `status ${r.status}`);
}

// ---- create --------------------------------------------------------------
let ticketId;
{
  const r = await api('/api/tickets', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      subject: '打印机无法连接',
      body: '三楼打印机离线，需要更换网线',
      requesterEmail: 'zhang@example.com',
      requesterName: '张三',
      priority: 'high',
      tags: ['硬件', '紧急'],
    }),
  });
  ticketId = r.body?.id;
  check('create returns 201', r.status === 201, `status ${r.status}`);
  check('utf8 subject roundtrips', r.body?.subject === '打印机无法连接', r.body?.subject);
  check('utf8 tags roundtrip', JSON.stringify(r.body?.tags) === '["硬件","紧急"]', JSON.stringify(r.body?.tags));
  check('new ticket defaults to open', r.body?.status === 'open');
}
{
  const r = await api('/api/tickets', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ subject: 'x', requesterEmail: 'not-an-email' }),
  });
  check('invalid email rejected with 422', r.status === 422, `status ${r.status}`);
}
{
  const r = await api('/api/tickets', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ subject: '', requesterEmail: 'a@b.com' }),
  });
  check('empty subject rejected', r.status === 422, `status ${r.status}`);
}

// ---- read & filter -------------------------------------------------------
{
  const r = await api('/api/tickets', { headers: auth });
  check('list returns the ticket', r.body?.total >= 1, `total ${r.body?.total}`);
  const item = r.body?.items?.find((t) => t.id === ticketId);
  check('list hydrates tags', Array.isArray(item?.tags) && item.tags.length === 2);
  check('list hydrates commentCount', item?.commentCount === 0);
}
{
  const r = await api('/api/tickets?status=closed', { headers: auth });
  const hasIt = r.body?.items?.some((t) => t.id === ticketId);
  check('status filter excludes open ticket', !hasIt);
}
{
  const r = await api('/api/tickets?q=%E6%89%93%E5%8D%B0%E6%9C%BA', { headers: auth });
  const hasIt = r.body?.items?.some((t) => t.id === ticketId);
  check('text search finds by subject', hasIt);
}
{
  const r = await api('/api/tickets?tag=%E7%A1%AC%E4%BB%B6', { headers: auth });
  const hasIt = r.body?.items?.some((t) => t.id === ticketId);
  check('tag filter works', hasIt);
}

// ---- update & status derivation -----------------------------------------
{
  const r = await api(`/api/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: jsonAuth,
    body: JSON.stringify({ status: 'closed' }),
  });
  check('close sets status', r.body?.status === 'closed');
  check('close sets closedAt', typeof r.body?.closedAt === 'string' && r.body.closedAt.length > 0);
}
{
  const r = await api(`/api/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: jsonAuth,
    body: JSON.stringify({ status: 'open' }),
  });
  check('reopen clears closedAt', r.body?.closedAt === null, String(r.body?.closedAt));
}

// ---- comments & the internal-note guarantee ------------------------------
{
  const r = await api(`/api/tickets/${ticketId}/comments`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ body: '已联系供应商', authorEmail: 'agent@example.com' }),
  });
  check('public comment created', r.status === 201 && r.body?.isInternal === false);
}
{
  const r = await api(`/api/tickets/${ticketId}/comments`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ body: '内部：客户很难缠', isInternal: true }),
  });
  check('internal note created', r.status === 201 && r.body?.isInternal === true);
}
{
  const r = await api(`/api/tickets/${ticketId}/comments`, { headers: auth });
  check('internal note hidden by default', r.body?.items?.length === 1, `got ${r.body?.items?.length}`);
}
{
  const r = await api(`/api/tickets/${ticketId}/comments?includeInternal=true`, { headers: auth });
  check('internal note visible on request', r.body?.items?.length === 2, `got ${r.body?.items?.length}`);
}
{
  const r = await api(`/api/tickets/${ticketId}`, { headers: auth });
  check('detail hides internal notes by default', r.body?.comments?.length === 1);
  check('comment count reflected', r.body?.commentCount === 2, `got ${r.body?.commentCount}`);
}

// ---- users, tags, stats --------------------------------------------------
let userId;
{
  const r = await api('/api/users', { headers: auth });
  check('users list works', r.status === 200 && Array.isArray(r.body?.items));
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ email: 'agent@example.com', name: '客服小王' }),
  });
  userId = r.body?.id;
  check('create user returns 201', r.status === 201, `status ${r.status}`);
  check('utf8 user name roundtrips', r.body?.name === '客服小王', r.body?.name);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ email: 'agent@example.com', name: '重复' }),
  });
  check('duplicate email rejected with 409', r.status === 409, `status ${r.status}`);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ email: 'not-an-email', name: 'x' }),
  });
  check('invalid user email rejected with 422', r.status === 422, `status ${r.status}`);
}
{
  const r = await api(`/api/users/${userId}`, {
    method: 'PATCH',
    headers: jsonAuth,
    body: JSON.stringify({ name: '客服小李' }),
  });
  check('update user works', r.status === 200 && r.body?.name === '客服小李', `status ${r.status}`);
}
{
  const r = await api(`/api/users/${userId}`, { headers: auth });
  check('user detail works', r.status === 200 && r.body?.email === 'agent@example.com');
}
{
  const r = await api('/api/users/999999', { headers: auth });
  check('missing user returns 404', r.status === 404, `status ${r.status}`);
}
{
  const r = await api('/api/tags', { headers: auth });
  check('tags list works', r.status === 200 && r.body?.items?.length >= 2);
}
{
  const r = await api('/api/stats', { headers: auth });
  check('stats counts correctly', r.body?.total >= 1, JSON.stringify(r.body));
}

// ---- UI surface ----------------------------------------------------------
{
  const res = await fetch(`${base}/`);
  const html = await res.text();
  check('list page renders', res.status === 200 && html.includes('liteticket'));
  check('page includes htmx', html.includes('/static/htmx.min.js'));
  check('page renders ticket row', html.includes('打印机无法连接'));
}
{
  const res = await fetch(`${base}/static/htmx.min.js`);
  check('htmx asset served', res.status === 200);
}
{
  const res = await fetch(`${base}/tickets/${ticketId}`);
  const html = await res.text();
  check('detail page renders', res.status === 200 && html.includes('已联系供应商'));
  check('detail page shows internal note to agent', html.includes('内部：客户很难缠'));
}
{
  const res = await fetch(`${base}/new`);
  check('new ticket page renders', res.status === 200 && (await res.text()).includes('新建工单'));
}
{
  const res = await fetch(`${base}/api-docs`);
  check('api docs page renders', res.status === 200);
}
{
  const res = await fetch(`${base}/users`);
  const html = await res.text();
  check('users page renders', res.status === 200 && html.includes('客服小李'));
}
{
  const res = await fetch(`${base}/ui/tickets`);
  const html = await res.text();
  check('htmx fragment returns rows without <html>', !html.includes('<html') && html.includes('ticket-list'));
}
{
  const res = await fetch(`${base}/ui/tickets/${ticketId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'status=closed',
  });
  const html = await res.text();
  check('htmx status swap returns row fragment', res.status === 200 && html.includes(`row-${ticketId}`));
  check('fragment reflects new status', html.includes('s-closed'));
}
{
  const res = await fetch(`${base}/ui/tickets/${ticketId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'status=bogus',
  });
  check('invalid status rejected with 400', res.status === 400, `status ${res.status}`);
}

// ---- delete --------------------------------------------------------------
{
  const r = await api(`/api/users/${userId}`, { method: 'DELETE', headers: auth });
  check('delete user returns 204', r.status === 204, `status ${r.status}`);
}
{
  const r = await api(`/api/users/${userId}`, { headers: auth });
  check('deleted user is gone', r.status === 404, `status ${r.status}`);
}
{
  const r = await api(`/api/tickets/${ticketId}`, { method: 'DELETE', headers: auth });
  check('delete returns 204', r.status === 204, `status ${r.status}`);
}
{
  const r = await api(`/api/tickets/${ticketId}`, { headers: auth });
  check('deleted ticket is gone', r.status === 404, `status ${r.status}`);
}
{
  const r = await api('/api/tickets/999999', { headers: auth });
  check('missing ticket returns 404', r.status === 404, `status ${r.status}`);
}
{
  const r = await api('/api/nope', { headers: auth });
  check('unknown api route returns json 404', r.status === 404 && r.body?.error === 'not found');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
