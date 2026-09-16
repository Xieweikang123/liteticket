import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { Loading } from './ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { TicketListPage } from './pages/TicketList.tsx';
import { TicketDetailPage } from './pages/TicketDetail.tsx';
import { UsersPage } from './pages/Users.tsx';
import { RolesPage } from './pages/Roles.tsx';
import { MenusPage } from './pages/Menus.tsx';
import { TokensPage } from './pages/Tokens.tsx';
import { AccountPage, ChangePasswordDrawer } from './pages/Account.tsx';

/**
 * A nav tab. React Router already appends `active` to the className it is
 * given, so passing the literal string is enough — the per-link
 * `({ isActive }) => ...` callback this replaced only ever restated that.
 */
function Tab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink to={to} end={end} className="tab">
      {children}
    </NavLink>
  );
}

/**
 * Identity and the account actions, folded into one control.
 *
 * 退出 used to sit loose in the bar next to the user's name, and 修改密码 had a
 * tab of its own — three separate places for one account. A menu keeps the
 * work tabs for work and gathers the account's own actions behind the name
 * they belong to.
 *
 * It closes on outside click and on Escape because it is anchored to a
 * toggle rather than to a scrim: a dropdown that only closes by clicking its
 * own button strands anyone who opened it by mistake. The 修改密码 entry opens a
 * drawer instead of a route, so the page underneath is never left behind.
 */
function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  // The badge names the built-in `admin` role, not the capability: a custom
  // role holding `roles.manage` is not this one, and labelling it 管理员 would
  // be a claim the row itself does not make.
  const admin = user?.role === 'admin';

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return <Link to="/login">登录</Link>;

  return (
    <span className="who" ref={wrap}>
      <button
        className="who-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="who-name">{user.name}</span>
        {admin && <span className="who-role">管理员</span>}
        <span className="who-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="who-menu" role="menu">
          <div className="who-menu-head">
            <span className="who-menu-name">{user.name}</span>
            <span className="who-menu-user mono">{user.username}</span>
          </div>
          <Link to="/account" role="menuitem" onClick={() => setOpen(false)}>
            账号设置
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            修改密码
          </button>
          <button role="menuitem" onClick={() => void logout()}>
            退出
          </button>
        </div>
      )}
      {changing && <ChangePasswordDrawer onClose={() => setChanging(false)} />}
    </span>
  );
}

function TopBar() {
  const { menus } = useAuth();

  return (
    <header className="topbar">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">
          LT
        </span>
        liteticket
      </span>
      <nav>
        {menus.map((m) => (
          <Tab key={m.id} to={m.path} end={m.path === '/'}>
            {m.label}
          </Tab>
        ))}
      </nav>
      <UserMenu />
    </header>
  );
}

/** Sends anonymous visitors to the login page, remembering where they were. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="正在验证登录状态…" />;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();

  if (loading) return <Loading label="正在验证登录状态…" />;

  /**
   * The login page is a full-bleed split screen, so it renders outside the
   * `.wrap` container that centres and width-caps every other page. Nesting it
   * inside would clamp the brand panel to the wrapper's 1100px and push it off
   * the left edge instead of filling the viewport.
   */
  const bare = pathname === '/login';

  return (
    <>
      {user && <TopBar />}
      <div className={bare ? 'wrap bare' : 'wrap'}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <TicketListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tickets/:id"
            element={
              <RequireAuth>
                <TicketDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/users"
            element={
              <RequireAuth>
                <UsersPage />
              </RequireAuth>
            }
          />
          <Route
            path="/roles"
            element={
              <RequireAuth>
                <RolesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/menus"
            element={
              <RequireAuth>
                <MenusPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tokens"
            element={
              <RequireAuth>
                <TokensPage />
              </RequireAuth>
            }
          />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<div className="center">页面不存在</div>} />
        </Routes>
      </div>
    </>
  );
}
