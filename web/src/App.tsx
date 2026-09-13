import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, can } from './auth.tsx';
import { Loading } from './ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { TicketListPage } from './pages/TicketList.tsx';
import { TicketDetailPage } from './pages/TicketDetail.tsx';
import { UsersPage } from './pages/Users.tsx';
import { RolesPage } from './pages/Roles.tsx';
import { TokensPage } from './pages/Tokens.tsx';
import { AccountPage } from './pages/Account.tsx';

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

function TopBar() {
  const { user, permissions, logout } = useAuth();
  const admin = can(permissions, 'roles.manage');
  const canReadUsers = can(permissions, 'users.read');
  return (
    <header className="topbar">
      <span className="brand">liteticket</span>
      <nav>
        <Tab to="/" end>
          工单
        </Tab>
        {canReadUsers && <Tab to="/users">用户</Tab>}
        {admin && <Tab to="/roles">角色</Tab>}
        <Tab to="/tokens">我的令牌</Tab>
        <Tab to="/account">账号</Tab>
      </nav>
      <span className="who">
        {user ? (
          <>
            <span className="who-name">{user.name}</span>
            {admin && <span className="who-role">管理员</span>}
            <button className="link" onClick={logout}>
              退出
            </button>
          </>
        ) : (
          <Link to="/login">登录</Link>
        )}
      </span>
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
