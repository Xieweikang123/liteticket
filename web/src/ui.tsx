import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * The status breakdown that sits under a list's page title. The counts are the
 * whole point of the line, so each one gets its own cell and the number carries
 * the weight — as one run-on sentence, `0` and `11` read the same and the
 * backlog is invisible. A zero cell is dimmed rather than dropped, so the row
 * does not reflow as tickets change state.
 *
 * With `onSelect` the same row is the status filter, which removes the usual
 * "read the count here, change the filter over there" round trip. Counts come
 * from the unfiltered stats, so the numbers hold still while a filter is on.
 */
export function StatusCounts({
  counts,
  active,
  onSelect,
}: {
  counts: { open: number; pending: number; closed: number; total: number };
  active?: string;
  onSelect?: (status: string) => void;
}) {
  const tabs = [
    { key: '', label: '全部', count: counts.total },
    ...(['open', 'pending', 'closed'] as const).map((s) => ({
      key: s,
      label: STATUS_LABEL[s],
      count: counts[s] ?? 0,
    })),
  ];
  return (
    <span className="stat-strip">
      {tabs.map((t) => {
        const isActive = (active ?? '') === t.key;
        const body = (
          <>
            {t.key && <span className={`stat-dot ${t.key}`} aria-hidden="true" />}
            {t.label} <b className="stat-num">{t.count}</b>
          </>
        );
        const cls = `stat${isActive ? ' active' : ''}${t.count === 0 && t.key ? ' zero' : ''}`;
        if (!onSelect) {
          return (
            <span key={t.key || 'all'} className={cls}>
              {body}
            </span>
          );
        }
        return (
          <button
            key={t.key || 'all'}
            type="button"
            className={`${cls} stat-btn`}
            aria-pressed={isActive}
            onClick={() => onSelect(t.key)}
          >
            {body}
          </button>
        );
      })}
    </span>
  );
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
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** A page-level heading: what this page is, and the count that goes with it. */
export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted small page-head-sub">{sub}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

/**
 * The resting state of a list with nothing in it. An outlined tray rather than
 * bare text, so an empty table still reads as a deliberate state and not a
 * rendering failure.
 */
export function Empty({ label }: { label: string }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false">
        <path
          d="M3.5 13.5 6 6.5A2 2 0 0 1 7.9 5h8.2a2 2 0 0 1 1.9 1.5l2.5 7v3.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M3.5 14.5h5l1 2h5l1-2h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {label}
    </div>
  );
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
 * A destructive action that asks in place.
 *
 * This replaced window.confirm, which on a Chinese UI renders a browser-chrome
 * dialog with English buttons and no styling — it looked like a different
 * application. Confirming inline also keeps the question next to the thing it
 * is about, and because it is a two-step button rather than a modal, it cannot
 * be dismissed by a stray Escape the way the create drawer can. That
 * distinction is the point: creating is cheap and reversible, deleting is not.
 *
 * The confirm step reverts on blur, so a half-pressed delete button does not
 * sit armed in the row while the user does something else.
 */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  disabled,
}: {
  label: string;
  question: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  // Move focus to the confirm step: the user asked to delete, and a keyboard
  // user must not have to tab to the new button that just appeared.
  useEffect(() => {
    if (armed) wrap.current?.querySelector('button')?.focus();
  }, [armed]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      // The callers surface their own failures through the page's error box;
      // swallowing here only stops a rejected promise from escaping the click
      // handler as an unhandled rejection.
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <button className="danger" onClick={() => setArmed(true)} disabled={disabled}>
        {label}
      </button>
    );
  }

  return (
    <span
      className="confirm"
      ref={wrap}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArmed(false);
      }}
    >
      <span className="confirm-ask">{question}</span>
      <button className="danger solid" onClick={() => void confirm()} disabled={busy}>
        {busy ? '删除中…' : '确认删除'}
      </button>
      <button onClick={() => setArmed(false)} disabled={busy}>
        取消
      </button>
    </span>
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
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** For a view rather than a form — the ticket detail needs the room. */
  wide?: boolean;
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

  // Portalled to <body>: several drawers are opened from inside a table row,
  // and a block-level `<div>` is not legal as a `<tbody>` child.
  return createPortal(
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className={`drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="drawer-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
