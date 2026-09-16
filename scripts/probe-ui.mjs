/**
 * Real-browser test of the React client.
 *
 * The HTTP probes only prove the server responds; they cannot catch a client
 * that renders a blank page, crashes on mount, or fails to attach the bearer
 * token. This drives an actual browser against the running app and exercises
 * the flows a user performs.
 *
 * Usage:
 *   node scripts/probe-ui.mjs [baseUrl]
 *
 * Credentials come from PROBE_USERNAME / PROBE_PASSWORD and must match the
 * instance's seeded admin (LITETICKET_ADMIN_USERNAME / LITETICKET_ADMIN_PASSWORD).
 * The defaults match the documented seed (`admin` / `1`).
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const USERNAME = process.env.PROBE_USERNAME ?? 'admin';
const PASSWORD = process.env.PROBE_PASSWORD ?? '1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// Prefer the bundled chromium, fall back to an installed Chrome.
const bundled = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch({
  executablePath: bundled,
  channel: bundled ? undefined : 'chrome',
  headless: true,
});

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

/** Collect console errors and failed requests; a clean run must have none. */
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  // ---- login is required ---------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  check(
    'anonymous visit redirects to /login',
    page.url().includes('/login'),
    `url=${page.url()}`,
  );
  check('login form rendered', (await page.locator('input[type="password"]').count()) === 1);

  // ---- wrong password is rejected -----------------------------------------
  await page.fill('input[type="password"]', 'definitely-wrong');
  await page.locator('form input').first().fill(USERNAME);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.error', { timeout: 8000 }).catch(() => {});
  check('wrong password shows an error', (await page.locator('.error').count()) > 0);
  check('still on /login after failure', page.url().includes('/login'), `url=${page.url()}`);

  // ---- correct password logs in -------------------------------------------
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 10000 });
  check('successful login leaves /login', !page.url().includes('/login'), `url=${page.url()}`);

  await page.waitForSelector('.topbar', { timeout: 8000 });
  check('top bar rendered after login', (await page.locator('.topbar').count()) === 1);
  check(
    'token persisted to localStorage',
    (await page.evaluate(() => localStorage.getItem('liteticket.token'))) !== null,
  );

  // The admin nav entry only exists for an admin role, so this also proves the
  // role survived the round trip through the token.
  check('admin sees the Users nav link', (await page.locator('nav a', { hasText: '用户' }).count()) > 0);

  // ---- create a ticket -----------------------------------------------------
  // Creating opens a drawer whose form carries a stable id; the title lives in
  // the drawer header, so match on the id rather than on form text.
  await page.click('button:has-text("新建工单")');
  const newForm = page.locator('form#new-ticket-form');
  await newForm.waitFor({ timeout: 8000 });

  const subject = `浏览器测试工单 ${Date.now()}`;
  // The subject input carries no `type` attribute, so select it positionally
  // within the labelled field rather than by type.
  await newForm.locator('.field:has-text("标题") input').fill(subject);
  await newForm.locator('textarea').fill('由自动化浏览器测试创建');
  await newForm.locator('input[type="email"]').fill('browser@example.com');
  // The submit button lives in the drawer footer, outside the form element, and
  // is associated by its `form` attribute.
  await page.locator('button[form="new-ticket-form"]').click();

  await page.waitForSelector(`a:has-text("${subject}")`, { timeout: 10000 });
  check('new ticket appears in the list', (await page.locator(`a:has-text("${subject}")`).count()) > 0);

  // ---- open the ticket -----------------------------------------------------
  await page.click(`a:has-text("${subject}")`);
  await page.waitForSelector('h2', { timeout: 8000 });
  check('ticket detail shows the subject', (await page.locator(`h2:has-text("${subject}")`).count()) > 0);
  check('detail page shows the body', (await page.locator('text=由自动化浏览器测试创建').count()) > 0);

  // ---- change status -------------------------------------------------------
  await page.locator('.field:has-text("状态") select').selectOption('pending');
  await page.waitForSelector('.pill.pending', { timeout: 8000 });
  check('status change is reflected', (await page.locator('.pill.pending').count()) > 0);

  // ---- add a public reply --------------------------------------------------
  // Type rather than `fill`: the comment box is uncontrolled-by-React in the
  // sense that its value is read back on submit, and `fill` sets the DOM value
  // without reliably dispatching the React state update, so the send button
  // can stay disabled. Typing exercises the same path a user does.
  const commentBox = page.locator('textarea[placeholder="写下回复…"]');

  await commentBox.click();
  await commentBox.pressSequentially('这是浏览器测试的回复', { delay: 10 });
  const sendBtn = page.locator('button:has-text("发送")');
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('发送'));
      return Boolean(btn && !btn.disabled);
    },
    { timeout: 8000 },
  );
  check('send button enables after typing', await sendBtn.isEnabled());
  await sendBtn.click();
  await page.waitForSelector('text=这是浏览器测试的回复', { timeout: 8000 });
  check('public reply is added', (await page.locator('text=这是浏览器测试的回复').count()) > 0);
  check('send button re-disables after a reply', await sendBtn.isDisabled());

  // ---- add an internal note ------------------------------------------------
  await commentBox.click();
  await commentBox.pressSequentially('这是内部备注', { delay: 10 });
  await page.locator('input[type="checkbox"]').check();
  check('checking internal keeps the text', (await commentBox.inputValue()) === '这是内部备注');
  await sendBtn.click();
  await page.waitForSelector('.comment.internal', { timeout: 8000 });
  check('internal note is added and marked', (await page.locator('.comment.internal').count()) > 0);
  check(
    'comment form is not reset by the refresh',
    (await commentBox.count()) === 1,
    'the comment form should survive a post-submit refresh',
  );

  // ---- token self-service --------------------------------------------------
  await page.click('nav a:has-text("我的令牌")');
  await page.waitForSelector('form:has-text("签发新令牌")', { timeout: 8000 });
  check('tokens page rendered', (await page.locator('form:has-text("签发新令牌")').count()) > 0);

  // The login that got us here is a session, not a named credential: it must
  // not appear among the tokens the page manages.
  check(
    'the login session is not listed on the token page',
    (await page.locator('td:has-text("login-")').count()) === 0,
  );

  const tokenName = `ui-probe-${Date.now()}`;
  await page.fill('form:has-text("签发新令牌") input', tokenName);
  await page.click('form:has-text("签发新令牌") button[type="submit"]');
  await page.waitForSelector('.mono', { timeout: 8000 });

  const freshToken = (await page.locator('.ok.mono').first().innerText()).trim();
  check('a fresh token is displayed once', freshToken.length > 20, `len=${freshToken.length}`);

  // The table refreshes after the mint, so wait for the row rather than
  // sampling immediately.
  await page.waitForSelector(`td:has-text("${tokenName}")`, { timeout: 8000 }).catch(() => {});
  check('token name appears in the table', (await page.locator(`td:has-text("${tokenName}")`).count()) > 0);

  // ---- the token minted in the UI actually works against the API ------------
  const apiRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  check('UI-minted token authenticates against the API', apiRes.status === 200, `got ${apiRes.status}`);
  const me = await apiRes.json().catch(() => ({}));
  check('UI-minted token carries the admin role', me.role === 'admin', `got ${me.role}`);

  // ---- users page ----------------------------------------------------------
  await page.click('nav a:has-text("用户")');
  await page.waitForSelector('button:has-text("新建用户")', { timeout: 8000 });
  check('users page rendered', (await page.locator('button:has-text("新建用户")').count()) > 0);
  await page.waitForSelector('td:has-text("admin")', { timeout: 8000 });
  check('admin row is present', (await page.locator('td:has-text("admin")').count()) > 0);

  // ---- roles page ----------------------------------------------------------
  await page.click('nav a:has-text("角色")');
  await page.waitForSelector('button:has-text("新建角色")', { timeout: 8000 });
  check('roles page rendered', (await page.locator('button:has-text("新建角色")').count()) > 0);
  await page.waitForSelector('td:has-text("admin")', { timeout: 8000 });
  check('built-in admin role is listed', (await page.locator('td:has-text("admin")').count()) > 0);
  check(
    'built-in roles are marked as not editable',
    (await page.locator('text=不可编辑').count()) >= 2,
  );

  // ---- menus page ----------------------------------------------------------
  //
  // The nav is data now. This proves the management page renders, that the
  // built-in tabs are seeded as rows, and that the top bar is in fact driven by
  // that data: renaming a tab here must change the nav without a reload.
  await page.click('nav a:has-text("菜单")');
  await page.waitForSelector('button:has-text("新建菜单")', { timeout: 8000 });
  check('menus page rendered', (await page.locator('button:has-text("新建菜单")').count()) > 0);
  await page.waitForSelector('td:has-text("tickets")', { timeout: 8000 });
  check('built-in tickets menu is listed', (await page.locator('td:has-text("tickets")').count()) > 0);
  check('built-in menus are marked as system', (await page.locator('text=内置').count()) >= 2);

  // Rename 我的令牌 through the drawer and assert the nav follows. The target
  // is a tab that exists in the nav: what this proves is that the top bar is
  // driven by the menu rows, and the route behind the renamed row still works.
  const tokensRow = page.locator('tr:has(td:has-text("tokens"))').first();
  await tokensRow.locator('button:has-text("编辑")').click();
  const nameInput = page.locator('#edit-menu-form .field:has-text("名称") input');
  await nameInput.waitFor({ timeout: 8000 });
  await nameInput.fill('我的密钥');
  await page.locator('button[form="edit-menu-form"]').click();
  await page.waitForSelector('nav a:has-text("我的密钥")', { timeout: 8000 });
  check(
    'editing a menu updates the top nav without a reload',
    (await page.locator('nav a', { hasText: '我的密钥' }).count()) > 0,
  );

  // Renaming does not change the route: the tab must still work.
  await page.click('nav a:has-text("我的密钥")');
  await page.waitForSelector('form:has-text("签发新令牌")', { timeout: 8000 });
  check(
    'the renamed tab still navigates to its page',
    (await page.locator('form:has-text("签发新令牌")').count()) > 0,
  );

  // And the login session must not have been disturbed by the edit.
  check(
    'editing a menu keeps the session valid',
    (await page.evaluate(() => localStorage.getItem('liteticket.token'))) !== null,
  );

  // Restore the label through the API, so a repeat run starts from the seeded
  // state rather than accumulating renames.
  {
    const token = await page.evaluate(() => localStorage.getItem('liteticket.token'));
    const all = await fetch(`${BASE}/api/menus?all=true`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const tokens = all.items?.find((m) => m.name === 'tokens');
    if (tokens) {
      await fetch(`${BASE}/api/menus/${tokens.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '我的令牌' }),
      });
    }
  }

  // ---- an agent (non-admin) must boot cleanly ------------------------------
  //
  // This is the regression guard for a real bug: the client used to resolve
  // the signed-in user by calling GET /users, which is admin-only, so an agent
  // got a 403 on every page load. Runs while still logged in as admin, since
  // it needs an admin token to create the agent.
  const agentUsername = `agent-ui-${Date.now()}`;
  const agentEmail = `${agentUsername}@example.com`;
  const agentPassword = 'agentpass123';
  const adminToken = await page.evaluate(() => localStorage.getItem('liteticket.token'));

  const created = await fetch(`${BASE}/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: agentUsername,
      email: agentEmail,
      name: 'Agent UI',
      role: 'agent',
      password: agentPassword,
    }),
  });
  check('admin can create an agent via the API', created.status === 201, `got ${created.status}`);

  const agentContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const agentPage = await agentContext.newPage();
  const agentErrors = [];
  agentPage.on('console', (m) => {
    if (m.type() === 'error') agentErrors.push(m.text());
  });
  agentPage.on('pageerror', (e) => agentErrors.push(String(e)));

  await agentPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await agentPage.locator('form input').first().fill(agentUsername);
  await agentPage.fill('input[type="password"]', agentPassword);
  await agentPage.locator('button[type="submit"]').click();
  await agentPage.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 10000 });

  check('agent can log in through the UI', !agentPage.url().includes('/login'), `url=${agentPage.url()}`);
  check('agent sees the top bar', (await agentPage.locator('.topbar').count()) === 1);
  // The built-in agent role has users.read (so it can populate the assignee
  // picker) but not users.manage, so it sees the users list without the
  // management controls, and never the roles page.
  check(
    'agent sees the Users nav link (read-only)',
    (await agentPage.locator('nav a', { hasText: '用户' }).count()) > 0,
    'agent should at least see the users list',
  );
  check(
    'agent does NOT see the Roles nav link',
    (await agentPage.locator('nav a', { hasText: '角色' }).count()) === 0,
    'agent should not be offered role management',
  );
  check(
    'agent does NOT see the Menus nav link',
    (await agentPage.locator('nav a', { hasText: '菜单' }).count()) === 0,
    'agent should not be offered menu management',
  );
  check(
    'agent sees the token self-service link',
    (await agentPage.locator('nav a', { hasText: '我的令牌' }).count()) > 0,
  );
  // 账号 is not a tab, so an agent reaches it the same way an admin does.
  check(
    'agent does NOT see an account tab',
    (await agentPage.locator('nav a', { hasText: '账号' }).count()) === 0,
  );
  check(
    'agent has the user menu',
    (await agentPage.locator('.who-toggle').count()) === 1,
  );

  // A non-admin has no users.manage, so the account page is the only place they
  // can change their password. Exercise it for real: open the menu, follow the
  // 账号 link, expand the form, submit it.
  await agentPage.click('.who-toggle');
  await agentPage.click('.who-menu a:has-text("账号")');
  await agentPage.waitForSelector('button:has-text("修改密码")', { timeout: 8000 });
  check('the account page opens with the form collapsed', (await agentPage.locator('#account-new-password').count()) === 0);
  await agentPage.click('button:has-text("修改密码")');
  await agentPage.waitForSelector('#account-new-password', { timeout: 8000 });
  check('the account page reveals the password form', (await agentPage.locator('#account-new-password').count()) > 0);
  await agentPage.locator('.field:has-text("当前密码") input').fill(agentPassword);
  await agentPage.fill('#account-new-password', 'agentpass456');
  await agentPage.fill('#account-confirm-password', 'agentpass456');
  await agentPage.locator('button[type="submit"]:has-text("修改密码")').click();
  await agentPage.waitForFunction(() => location.pathname.startsWith('/login'), { timeout: 8000 });
  check('password change logs the agent out', agentPage.url().includes('/login'), `url=${agentPage.url()}`);

  // The change revoked the old token, so sign back in with the new password
  // before the remaining agent checks.
  await agentPage.locator('form input').first().fill(agentUsername);
  await agentPage.fill('input[type="password"]', 'agentpass456');
  await agentPage.locator('button[type="submit"]').click();
  await agentPage.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 10000 });
  check('agent can log in with the new password', !agentPage.url().includes('/login'), `url=${agentPage.url()}`);

  // An agent may still work tickets.
  await agentPage.click('nav a:has-text("工单")');
  await agentPage.click(`a:has-text("${subject}")`);
  await agentPage.waitForSelector('h2', { timeout: 8000 });
  check('agent can open a ticket', (await agentPage.locator(`h2:has-text("${subject}")`).count()) > 0);
  check(
    'agent is not offered ticket deletion (admin-only)',
    (await agentPage.locator('button:has-text("删除工单")').count()) === 0,
  );

  const agentConsoleIssues = agentErrors.filter((e) => !e.includes('favicon') && !e.includes('404'));
  check(
    'agent page load produces no console errors',
    agentConsoleIssues.length === 0,
    agentConsoleIssues.join(' | '),
  );

  await agentContext.close();

  // ---- logout (last: it clears the token the checks above depend on) --------
  // 退出 lives in the user menu now, so the menu has to be opened first.
  await page.click('.who-toggle');
  await page.click('.who-menu button:has-text("退出")');
  await page.waitForFunction(() => location.pathname.startsWith('/login'), { timeout: 8000 });
  check('logout returns to /login', page.url().includes('/login'), `url=${page.url()}`);
  check(
    'logout clears the stored token',
    (await page.evaluate(() => localStorage.getItem('liteticket.token'))) === null,
  );

  // ---- deep link while logged out -----------------------------------------
  await page.goto(`${BASE}/tickets/1`, { waitUntil: 'networkidle' });
  check(
    'deep link while logged out redirects to /login',
    page.url().includes('/login'),
    `url=${page.url()}`,
  );
  check(
    'login redirect remembers the target',
    decodeURIComponent(page.url()).includes('/tickets/1'),
    `url=${page.url()}`,
  );

  // ---- no client-side crashes ---------------------------------------------
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  const realConsoleErrors = consoleErrors.filter(
    (e) =>
      !e.includes('favicon') &&
      // Both of these are expected and produced deliberately by the test: the
      // wrong-password attempt (401) and the pre-login deep-link probe.
      !e.includes('401') &&
      !e.includes('404'),
  );
  check('no unexpected console errors', realConsoleErrors.length === 0, realConsoleErrors.join(' | '));
} catch (err) {
  fail++;
  failures.push(`threw: ${err}`);
  console.log(`  FAIL threw: ${err}`);
  await page.screenshot({ path: 'probe-ui-failure.png' }).catch(() => {});
  console.log('  (screenshot written to probe-ui-failure.png)');
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`\nfailures:\n  ${failures.join('\n  ')}`);
process.exit(fail === 0 ? 0 : 1);
