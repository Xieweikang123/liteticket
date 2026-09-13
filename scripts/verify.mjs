/**
 * End-to-end verification for liteticket.
 *
 * Run against a live server:
 *   node scripts/verify.mjs <token> [baseUrl] [adminUsername] [adminPassword]
 *
 * Uses fetch with explicit UTF-8 so results are not affected by the terminal's
 * console encoding.
 */
const token = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
const adminUsername = process.argv[4] ?? 'admin';
const adminPassword = process.argv[5] ?? '1';

if (!token) {
  console.error('usage: node scripts/verify.mjs <token> [baseUrl] [adminUsername] [adminPassword]');
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
  return { status: res.status, body, res };
}

/**
 * Log in and return a bearer token, or null when the credentials fail.
 *
 * The API is the only auth surface now: there is no login page and no session
 * cookie, so authentication for a human and for a script is the same call.
 */
async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username, password, tokenName: 'verify' }),
  });
  if (res.status !== 200) return null;
  const body = await res.json().catch(() => null);
  return body?.token ?? null;
}

/** GET a path as a browser would. */
async function page(path, token) {
  const res = await fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const html = res.status === 200 ? await res.text() : '';
  return { status: res.status, html, location: res.headers.get('location'), type: res.headers.get('content-type') ?? '' };
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

// ---- login -----------------------------------------------------------------
let sessionToken;
{
  const t = await login(adminUsername, adminPassword);
  sessionToken = t;
  check('admin can log in and receive a token', Boolean(t), 'no token returned');
}
{
  const t = await login(adminUsername, 'definitely-wrong');
  check('wrong password rejected', t === null);
}
{
  const r = await api('/api/auth/me', { headers: { Authorization: `Bearer ${sessionToken}` } });
  check('login token authenticates', r.status === 200, `status ${r.status}`);
  check('login token reports the owner role', r.body?.role === 'admin', `role ${r.body?.role}`);
  check('login token is bound to a user', typeof r.body?.userId === 'number', `userId ${r.body?.userId}`);
  check('login token carries the user identity', r.body?.user?.username === adminUsername, `username ${r.body?.user?.username}`);
}
{
  // The SPA shell is public: the client redirects to /login itself once it
  // finds no token, so the server no longer needs to.
  const p = await page('/', undefined);
  check('SPA shell is served without auth', p.status === 200 && p.html.includes('id="root"'), `status ${p.status}`);
}
{
  const p = await page('/tickets/1', undefined);
  check('deep link serves the SPA shell', p.status === 200 && p.html.includes('id="root"'), `status ${p.status}`);
}
{
  // There is no server-rendered login page any more.
  const p = await page('/login', undefined);
  check('no legacy server login page', !p.html.includes('name="password"'), 'found a server-rendered password form');
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
    body: JSON.stringify({ username: 'agent-wang', email: 'agent@example.com', name: '客服小王' }),
  });
  userId = r.body?.id;
  check('create user returns 201', r.status === 201, `status ${r.status}`);
  check('utf8 user name roundtrips', r.body?.name === '客服小王', r.body?.name);
  check('username roundtrips', r.body?.username === 'agent-wang', r.body?.username);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ username: 'agent-wang', email: 'other@example.com', name: '重复' }),
  });
  check('duplicate username rejected with 409', r.status === 409, `status ${r.status}`);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ username: 'agent-other', email: 'agent@example.com', name: '重复' }),
  });
  check('duplicate email rejected with 409', r.status === 409, `status ${r.status}`);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ username: 'bad name', email: 'a@b.com', name: 'x' }),
  });
  check('invalid username rejected with 422', r.status === 422, `status ${r.status}`);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ username: 'agent-x', email: 'not-an-email', name: 'x' }),
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

// ---- client (SPA) surface ------------------------------------------------
//
// The server no longer renders any HTML for the app: it serves the built
// React bundle and a catch-all that returns index.html so client-side routes
// survive a hard refresh. Content checks live in the browser suite
// (scripts/probe-ui.mjs), which drives a real browser.
{
  const p = await page('/', undefined);
  check('SPA shell renders', p.status === 200 && p.html.includes('id="root"'), `status ${p.status}`);
  check('SPA shell loads a bundled script', /\/assets\/index-[\w-]+\.js/.test(p.html));
  check('no htmx is shipped any more', !p.html.includes('htmx'));
}
{
  // The htmx bundle is deleted from the repo. The catch-all may answer this
  // path with the SPA shell, so assert the thing that actually matters: the
  // library is not shipped and the shell never references it.
  const res = await fetch(`${base}/static/htmx.min.js`);
  const body = await res.text();
  const looksLikeHtmx = body.includes('htmx') && body.length > 5000;
  check('legacy htmx asset is no longer shipped', !looksLikeHtmx, `status ${res.status}, ${body.length} bytes`);
}
{
  const p = await page('/users', undefined);
  check('client route /users falls back to the shell', p.status === 200 && p.html.includes('id="root"'), `status ${p.status}`);
}
{
  const p = await page(`/tickets/${ticketId}`, undefined);
  check('client route /tickets/:id falls back to the shell', p.status === 200 && p.html.includes('id="root"'), `status ${p.status}`);
}

// ---- token self-service ---------------------------------------------------
{
  const r = await api('/api/tokens', { headers: { Authorization: `Bearer ${sessionToken}` } });
  check('a user can list their own tokens', r.status === 200, `status ${r.status}`);
  check('token list never leaks a hash', !JSON.stringify(r.body ?? {}).includes('tokenHash'));

  const made = await api('/api/tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: 'verify-self-issued' }),
  });
  check('a user can mint their own token', made.status === 201, `status ${made.status}`);

  const own = made.body?.token;
  if (own) {
    const used = await api('/api/auth/me', { headers: { Authorization: `Bearer ${own}` } });
    check('self-issued token works', used.status === 200, `status ${used.status}`);
    check('self-issued token inherits the admin role', used.body?.role === 'admin', `role ${used.body?.role}`);

    const listed = await api('/api/tokens', { headers: { Authorization: `Bearer ${sessionToken}` } });
    const row = listed.body?.items?.find((t) => t.name === 'verify-self-issued');
    if (row) {
      const del = await api(`/api/tokens/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      check('a user can revoke their own token', del.status === 204, `status ${del.status}`);
      const after = await api('/api/auth/me', { headers: { Authorization: `Bearer ${own}` } });
      check('revoked token stops working', after.status === 401, `status ${after.status}`);
    } else {
      check('self-issued token appears in the list', false, 'not found');
    }
  }
}
{
  // The bootstrap machine token has no owner, so it cannot manage tokens.
  const r = await api('/api/tokens', { headers: auth });
  check('an unbound machine token cannot list tokens', r.status === 400, `status ${r.status}`);
}

// ---- roles & guards ------------------------------------------------------
{
  const r = await api('/api/users', { headers: { Authorization: `Bearer ${sessionToken}` } });
  check('a login token can list users', r.status === 200, `status ${r.status}`);
}
{
  const r = await api('/api/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: 'nope', email: 'nope@example.com', name: 'nope', role: 'admin' }),
  });
  check('admin token may create a user', r.status === 201, `status ${r.status}`);
  if (r.body?.id) await api(`/api/users/${r.body.id}`, { method: 'DELETE', headers: auth });
}
{
  const r = await api('/api/users/999999', { method: 'DELETE', headers: auth });
  check('deleting a missing user returns 404', r.status === 404, `status ${r.status}`);
}
{
  // An agent token must not be able to administer.
  const created = await api('/api/users', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      username: 'plain-agent',
      email: 'plain-agent@example.com',
      name: '普通客服',
      role: 'agent',
      password: 'secret',
    }),
  });
  const agentId = created.body?.id;
  check('agent user created with role', created.body?.role === 'agent', JSON.stringify(created.body?.role));
  check('password hash is never returned', created.body && !('passwordHash' in created.body));

  const agentToken = await login('plain-agent', 'secret');
  check('agent can log in', Boolean(agentToken));

  if (agentToken) {
    const agentMe = await api('/api/auth/me', { headers: { Authorization: `Bearer ${agentToken}` } });
    check('agent token reports the agent role', agentMe.body?.role === 'agent', `role ${agentMe.body?.role}`);

    const denied = await api('/api/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ username: 'x', email: 'x@example.com', name: 'x' }),
    });
    check('agent cannot create users (403)', denied.status === 403, `status ${denied.status}`);

    const del = await api(`/api/tickets/${ticketId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    check('agent cannot delete tickets (403)', del.status === 403, `status ${del.status}`);

    const ok = await api('/api/tickets', { headers: { Authorization: `Bearer ${agentToken}` } });
    check('agent can still read tickets', ok.status === 200, `status ${ok.status}`);

    // The token inherits the role live, so a demotion applies immediately.
    await api(`/api/users/${agentId}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ role: 'admin' }),
    });
    const promoted = await api('/api/auth/me', { headers: { Authorization: `Bearer ${agentToken}` } });
    check(
      'a role change applies to an existing token immediately',
      promoted.body?.role === 'admin',
      `role ${promoted.body?.role}`,
    );
    await api(`/api/users/${agentId}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ role: 'agent' }),
    });

    // A password change must invalidate the tokens minted by the old password.
    // (Tokens are deleted with their owner, not by a password marker, so this
    // asserts the documented behaviour: old *login* tokens are revoked.)
    await api(`/api/users/${agentId}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ password: 'rotated' }),
    });
    const stale = await api('/api/auth/me', { headers: { Authorization: `Bearer ${agentToken}` } });
    check('password change revokes tokens issued from the old password', stale.status === 401, `status ${stale.status}`);

    const relogin = await login('plain-agent', 'rotated');
    check('the account can log in with the new password', Boolean(relogin));
  }

  if (agentId) await api(`/api/users/${agentId}`, { method: 'DELETE', headers: auth });
}
{
  // The last admin cannot be removed out from under the system.
  const list = await api('/api/users', { headers: auth });
  const admin = list.body?.items?.find((u) => u.username === adminUsername);
  if (admin) {
    const r = await api(`/api/users/${admin.id}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ role: 'agent' }),
    });
    check('last admin cannot be demoted', r.status === 409, `status ${r.status}`);
  } else {
    check('last admin cannot be demoted', false, 'seed admin not found');
  }
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
