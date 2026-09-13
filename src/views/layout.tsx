import type { Child } from 'hono/jsx';

export const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  pending: '进行中',
  closed: '已关闭',
};

export const PRIORITY_LABEL: Record<string, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

/**
 * The single stylesheet. Inlined into every page: one fewer request, and it
 * keeps "one command to run" honest — there is no asset pipeline to configure.
 */
export const CSS = `
:root{
  --bg:#f6f7f9; --card:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb;
  --accent:#2563eb; --open:#2563eb; --pending:#d97706; --closed:#6b7280;
  --low:#6b7280; --normal:#2563eb; --high:#d97706; --urgent:#dc2626;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px;
  display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
header h1{font-size:16px;margin:0;font-weight:650}
header .spacer{flex:1}
main{max-width:1080px;margin:20px auto;padding:0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  padding:10px 12px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.s-open{background:var(--open)} .s-pending{background:var(--pending)} .s-closed{background:var(--closed)}
.p-low{background:var(--low)} .p-normal{background:var(--normal)} .p-high{background:var(--high)} .p-urgent{background:var(--urgent)}
.tag{display:inline-block;padding:1px 7px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:12px;margin-right:4px}
.muted{color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input,select,textarea{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--fg)}
textarea{width:100%;min-height:90px;resize:vertical}
button{font:inherit;padding:7px 14px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;color:var(--fg)}
button:hover{background:#f3f4f6}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{background:#1d4ed8}
button.danger{color:#dc2626}
label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}
.field{margin-bottom:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.empty{padding:40px;text-align:center;color:var(--muted)}
.htmx-indicator{opacity:0;transition:opacity .15s}
.htmx-request .htmx-indicator,.htmx-request.htmx-indicator{opacity:1}
.comment{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin-bottom:14px}
.comment.internal{border-left-color:#d97706;background:#fffbeb;border-radius:0 6px 6px 0;padding:10px 12px}
.comment .meta{font-size:12px;color:var(--muted);margin-bottom:4px}
.comment .body{white-space:pre-wrap}
`;

export function Layout(props: {
  title: string;
  children: Child;
  active?: string;
  htmx?: boolean;
}) {
  const { title, children, active, htmx = true } = props;
  const nav = [
    { href: '/', label: '工单' },
    { href: '/new', label: '新建' },
    { href: '/users', label: '用户' },
    { href: '/api-docs', label: 'API' },
  ];

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · liteticket</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        {htmx && <script src="/static/htmx.min.js" defer />}
      </head>
      <body>
        <header>
          <h1>
            <a href="/">liteticket</a>
          </h1>
          {nav.map((n) => (
            <a href={n.href} class={active === n.href ? 'muted' : ''}>
              {n.label}
            </a>
          ))}
          <span class="spacer" />
          <span class="muted" id="stats">
            —
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span class={`pill s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PriorityPill({ priority }: { priority: string }) {
  return <span class={`pill p-${priority}`}>{PRIORITY_LABEL[priority] ?? priority}</span>;
}
