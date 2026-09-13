import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, isAdmin } from './auth.tsx';
import { Loading } from './ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { TicketListPage } from './pages/TicketList.tsx';
import { TicketDetailPage } from './pages/TicketDetail.tsx';
import { UsersPage } from './pages/Users.tsx';
import { TokensPage } from './pages/Tokens.tsx';

function TopBar() {
  const { user, logout } = useAuth();
  return (
    <div className="topbar">
      <span className="brand">liteticket</span>
      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          工单
        </NavLink>
        {isAdmin(user?.role) && (
          <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
            用户
          </NavLink>
        )}
        <NavLink to="/tokens" className={({ isActive }) => (isActive ? 'active' : '')}>
          我的 Token
        </NavLink>
      </nav>
      <span className="who small">
        {user ? (
          <>
            {user.name}
            {isAdmin(user.role) ? '（管理员）' : ''}
            <button className="link" onClick={logout}>
              退出
            </button>
          </>
        ) : (
          <Link to="/login">登录</Link>
        )}
      </span>
    </div>
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

  if (loading) return <Loading label="正在验证登录状态…" />;

  return (
    <>
      {user && <TopBar />}
      <div className="wrap">
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
            path="/tokens"
            element={
              <RequireAuth>
                <TokensPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<div className="center">页面不存在</div>} />
        </Routes>
      </div>
    </>
  );
}
