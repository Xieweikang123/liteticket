import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/index.ts';
import * as svc from '../services/tickets.ts';
import { passwordMarker, verifyPassword } from '../auth.ts';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionSecret,
  signSession,
} from '../auth.ts';
import { readSession } from '../session.ts';
import { Layout } from '../views/layout.tsx';

/** Only allow same-site absolute paths, so `next` cannot become an open redirect. */
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export function loginRoutes(db: Db) {
  const auth = new Hono();

  auth.get('/login', async (c) => {
    // Already signed in? Skip the form.
    if (await readSession(c, db)) return c.redirect(safeNext(c.req.query('next')), 303);

    const next = safeNext(c.req.query('next'));
    const failed = c.req.query('error') === '1';

    return c.html(
      <Layout title="登录" htmx={false}>
        <div class="card" style="max-width:380px;margin:60px auto">
          <h2 style="margin-top:0">登录 liteticket</h2>
          {failed && <p style="color:#dc2626">邮箱或密码不正确。</p>}
          <form method="post" action="/login">
            <input type="hidden" name="next" value={next} />
            <div class="field">
              <label for="email">邮箱</label>
              <input id="email" name="email" type="email" required style="width:100%" autofocus />
            </div>
            <div class="field">
              <label for="password">密码</label>
              <input id="password" name="password" type="password" required style="width:100%" />
            </div>
            <button class="primary" type="submit" style="width:100%">
              登录
            </button>
          </form>
        </div>
      </Layout>,
    );
  });

  auth.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const next = safeNext(String(body.next ?? '/'));

    const record = await svc.getUserForAuth(db, email);
    if (!record || !verifyPassword(password, record.passwordHash)) {
      return c.redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
    }

    const secret = await sessionSecret(db);
    const cookie = signSession(secret, {
      uid: record.id,
      pw: passwordMarker(record.passwordHash),
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });

    setCookie(c, SESSION_COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.redirect(next, 303);
  });

  auth.get('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login', 303);
  });

  return auth;
}
