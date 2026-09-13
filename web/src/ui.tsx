import { useEffect } from 'react';
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

/**
 * A right-hand sheet for editing one record.
 *
 * Editing used to happen inside the table row, which forced every form into a
 * single line of cells — fine for two fields, unreadable at five. A drawer
 * gives the form its own column instead, and the list stays visible behind it
 * so the user keeps the context of what they are editing.
 *
 * It is deliberately not a modal: the overlay is a scrim you can click away,
 * and Escape closes. The panel only animates on open — unmounting on close
 * would need an exit animation the reduced-motion path would have to undo.
 */
export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while the sheet owns the viewport.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="drawer-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}
