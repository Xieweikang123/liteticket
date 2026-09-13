import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { TokenRow } from '../api.ts';
import { Empty, ErrorBox, Field, Loading, formatTime } from '../ui.tsx';

/**
 * Self-service API tokens.
 *
 * Before this page existed, a logged-in user had no way to obtain an API
 * token: the only one ever minted was the bootstrap token printed to the
 * server console on first boot. Now a user can mint and revoke their own.
 */
export function TokensPage() {
  const [items, setItems] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listTokens();
      setItems(r.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createToken(name);
      setFresh(r.token);
      setName('');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    if (!confirm('吊销这个 token？使用它的程序会立即失去访问权限。')) return;
    setError(null);
    try {
      await api.revokeToken(id);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      {fresh && (
        <div className="card">
          <h2>新 token（只显示这一次）</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            请立刻复制保存。服务端只存哈希，关闭后无法再次查看。
          </p>
          <div className="ok mono">{fresh}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="primary"
              onClick={() => {
                void navigator.clipboard?.writeText(fresh);
              }}
            >
              复制
            </button>
            <button onClick={() => setFresh(null)}>我已保存</button>
          </div>
        </div>
      )}

      <form className="card" onSubmit={create}>
        <h2>签发新 token</h2>
        <ErrorBox error={error} />
        <div className="row">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field label="用途说明">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：ci-deploy"
                style={{ width: '100%' }}
                required
              />
            </Field>
          </div>
          <button className="primary" type="submit" disabled={busy || !name.trim()} style={{ marginTop: 18 }}>
            {busy ? '签发中…' : '签发'}
          </button>
        </div>
      </form>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty label="还没有属于你的 token" />
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>用途</th>
                <th style={{ width: 150 }}>创建时间</th>
                <th style={{ width: 150 }}>最后使用</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="muted">{t.id}</td>
                  <td>{t.name}</td>
                  <td className="small muted">{formatTime(t.createdAt)}</td>
                  <td className="small muted">{t.lastUsedAt ? formatTime(t.lastUsedAt) : '从未使用'}</td>
                  <td>
                    <button className="danger" onClick={() => void revoke(t.id)}>
                      吊销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>怎么用</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          所有接口都需要在请求头带上 token：
        </p>
        <div className="mono">Authorization: Bearer &lt;token&gt;</div>
        <p className="muted small">
          示例：
          <br />
          <span className="mono">curl -H "Authorization: Bearer $TOKEN" /api/tickets</span>
        </p>
      </div>
    </>
  );
}
