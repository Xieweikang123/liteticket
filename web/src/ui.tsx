import type { ReactNode } from 'react';

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

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PriorityPill({ priority }: { priority: string }) {
  return <span className={`pill ${priority}`}>{PRIORITY_LABEL[priority] ?? priority}</span>;
}

/** Render an API timestamp (SQLite `datetime('now')`, UTC, no zone) as local time. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = (error as { issues?: { path: string; message: string }[] }).issues;
  return (
    <div className="error">
      {message}
      {issues && issues.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {issues.map((i) => (
            <li key={`${i.path}-${i.message}`}>
              {i.path ? `${i.path}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return <div className="center">{label}</div>;
}

export function Empty({ label }: { label: string }) {
  return <div className="center">{label}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}
